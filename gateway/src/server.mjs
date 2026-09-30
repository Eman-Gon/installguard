import { Workflow } from './workflow.mjs';
import { DEPENDENCY_PROFILE } from '../../shared/dependency.mjs';
import { validateRequest as validateWorkerRequest } from '../../service/contract.mjs';
import { profiles, profileFor } from '../../shared/profiles.mjs';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Store, digest } from './store.mjs';
import Ajv from 'ajv';
import { createHash, timingSafeEqual } from 'node:crypto';
const ajv=new Ajv({strict:false});
const validateRequest=ajv.compile(JSON.parse(readFileSync(new URL('../../contracts/request.schema.json',import.meta.url))));
const validateResult=ajv.compile(JSON.parse(readFileSync(new URL('../../contracts/result.schema.json',import.meta.url))));
const checkInput=async input=>{if(!validateRequest(input))throw Object.assign(new Error('Invalid investigation request: '+ajv.errorsText(validateRequest.errors)),{status:400});try{await validateWorkerRequest(input);}catch(error){throw Object.assign(error,{status:400});}return input;};
const send = (res, status, data, headers={}) => { res.writeHead(status, {'content-type':'application/json','cache-control':'no-store',...headers}); res.end(JSON.stringify(data)); };
async function body(req) { let text=''; for await (const chunk of req) { text+=chunk; if (text.length>131072) throw Object.assign(new Error('Request too large'), {status:413}); } try { return JSON.parse(text); } catch { throw Object.assign(new Error('Invalid JSON'), {status:400}); } }
const proofHeaders = ['authorization','payment-signature','x-payment'];
const evidenceHeaders = ['payment-response','payment-receipt','x-payment-response'];
export function createGateway({store=new Store(), gateUrl='http://127.0.0.1:1402', gateToken, serviceUrl, serviceToken, accessToken, publicUrl='http://127.0.0.1:4312', fetchImpl=fetch}={}) {
  if (!gateToken || gateToken.length<24) throw new Error('INSTALLGUARD_GATE_TOKEN must contain at least 24 characters');
  if (!accessToken || accessToken.length < 24 || accessToken === gateToken) throw new Error('A separate INSTALLGUARD_ACCESS_TOKEN of at least 24 characters is required');
  const hasAccess=req=>{const got=Buffer.from(req.headers['x-installguard-token'] || '');const want=Buffer.from(accessToken);return got.length===want.length && timingSafeEqual(got,want);};
  const workflow=new Workflow(store.db);
  const locks=new Set();
  const update=(job,state,detail)=>{store.event(job,state,detail);store.save(job);};
  async function execute(id) {
    let job=store.get(id); job.execution.state='running'; update(job,'running');
    if (!serviceUrl) {
      job.execution.state='not_started'; job.result={requestId:id,requestDigest:'sha256:'+job.inputDigest,artifactDigest:job.input.artifact.digest,lockfileDigest:job.input.lockfileDigest,target:job.input.target,executionId:'fixture-'+id,execution:'not_started',fixture:true,finding:'inconclusive',installationPolicy:'review',exitCode:null,logs:[],evidence:[],limitations:['Fixture endpoint only. No installation or tests executed.'],recommendation:'review'};
      update(job,'result_returned','Clearly labeled fixture; worker not connected'); return;
    }
    try {
      const response=await fetchImpl(`${serviceUrl}/investigations`,{method:'POST',headers:{'content-type':'application/json',...(serviceToken?{authorization:`Bearer ${serviceToken}`}:{})},body:JSON.stringify(job.input),signal:AbortSignal.timeout(120000)});
      const result=await response.json(); if(response.ok && (!validateResult(result)||result.requestId!==id||result.requestDigest!=='sha256:'+job.inputDigest||result.artifactDigest!==job.input.artifact.digest||result.lockfileDigest!==job.input.lockfileDigest||digest(result.target)!==digest(job.input.target)))throw new Error('Invalid or mismatched worker evidence'); job=store.get(id); job.result=result;
      job.execution.state=response.ok ? result.execution : 'failed';
      update(job,response.ok?'result_returned':'execution_failed');
    } catch { job=store.get(id);job.execution.state='unknown';update(job,'execution_unknown','Worker response unavailable; reconcile before retry'); }
  }
  async function reconcile(id,res){
    let job=store.get(id);if(!job)return send(res,404,{error:'Not found'});
        if(job.payment.state!=='confirmed'||!serviceUrl)return send(res,409,{error:'Payment needs provider reconciliation; no charge will be retried',job});
        const upstream=await fetchImpl(`${serviceUrl}/jobs/${encodeURIComponent(id)}/reconcile`,{method:'POST',headers:serviceToken?{authorization:`Bearer ${serviceToken}`}:{},signal:AbortSignal.timeout(10000)});
        const result=await upstream.json();
        if(!upstream.ok||!validateResult(result)||result.requestId!==id||result.requestDigest!=='sha256:'+job.inputDigest||result.artifactDigest!==job.input.artifact.digest||result.lockfileDigest!==job.input.lockfileDigest||digest(result.target)!==digest(job.input.target))return send(res,409,{error:'No matching final worker evidence; manual review remains required',job});
        job.result=result;job.execution.state=result.execution;update(job,'reconciled','Retrieved existing worker result without execution or payment retry');return send(res,200,job);
  }
  const privateServer=createServer(async(req,res)=>{
    try {
      if(req.headers.authorization!==`Bearer ${gateToken}`) return send(res,401,{error:'Gateway authentication required'});
      if(req.method==='POST'&&req.url.startsWith('/reconcile/')){
        return await reconcile(decodeURIComponent(req.url.slice(11)),res);
      }
      if(req.method!=='POST'||req.url!=='/investigations') return send(res,404,{error:'Not found'});
      const input=await body(req), job=store.get(input.requestId);
      if(!job || job.inputDigest!==digest(input)) return send(res,409,{error:'No matching reserved request'});
      if(job.payment.state==='confirmed') return send(res,200,job);
      if(!['pending','unknown'].includes(job.payment.state)) return send(res,409,{error:'Payment reservation required'});
      job.payment.state='confirmed'; job.payment.evidence.push({kind:'verified_gateway_forward',at:new Date().toISOString(),network:'localnet',note:'Authenticated Pay gateway admitted this request; see receipt evidence when supplied.'});
      update(job,'paid','Sandbox gateway verified payment'); job.execution.state='queued';update(job,'queued');
      send(res,202,job); void execute(job.requestId);
    } catch(e) {send(res,e.status??500,{error:e.message});}
  });
  const publicServer=createServer(async(req,res)=>{
    try {
      const path=new URL(req.url,'http://localhost').pathname;
      if(req.method==='GET'&&path==='/') {res.writeHead(200,{'content-type':'text/html','content-security-policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'"});return res.end(readFileSync(new URL('../../web/index.html',import.meta.url)));}
      if (!hasAccess(req)) return send(res,401,{error:'Buyer access token required'});
      if(req.method==='GET'&&path==='/approvals')return send(res,200,workflow.list());
      if(path.startsWith('/projects/')) {
        const id=path.slice(10);
        if(req.method==='GET')return send(res,200,workflow.settings(id));
        if(req.method==='PUT')return send(res,200,workflow.set(id,(await body(req)).enabled));
      }
      if(path.startsWith('/approvals/')) {
        const id=path.split('/')[2];
        if(req.method==='GET'){const item=workflow.get(id);return send(res,item?200:404,item??{error:'Quote not found'});}
        if(req.method==='POST'&&path.endsWith('/decision')) {
          // Approval is a separate human UI action. Agent tools never expose this operation.
          if(req.headers.origin!==publicUrl||req.headers['x-installguard-human']!=='dashboard')return send(res,403,{error:'Approve the exact quote in the local dashboard'});
          const {decision,amount}=await body(req);return send(res,200,workflow.decide(id,decision,amount));
        }
      }
      if(req.method==='POST'&&/^\/jobs\/[^/]+\/reconcile$/.test(path)) return await reconcile(decodeURIComponent(path.split('/')[2]),res);
      if(req.method==='GET'&&path==='/profiles') return send(res,200,[...profiles().map(({id,package:pkg,target})=>({id,package:pkg,target})),{id:DEPENDENCY_PROFILE,package:{ecosystem:'npm',scope:'Exact public versions without dependencies'},target:{os:'linux',runtime:'node',version:'22.11.0',architectures:['x64','arm64']},execution:'docker-only',lifecycleScripts:false}]);
      if(req.method==='GET'&&path==='/jobs') return send(res,200,store.list());
      if(req.method==='GET'&&/^\/jobs\/[^/]+\/evidence$/.test(path)) {
        const job=store.get(decodeURIComponent(path.split('/')[2]));
        if(!job)return send(res,404,{error:'Job not found'});
        const evidence=job.result?.evidence?.[0];
        if(!serviceUrl||!evidence||!/^evidence\/[a-f0-9-]{36}\.json$/.test(evidence.reference))return send(res,404,{error:'No recorded evidence available'});
        const upstream=await fetchImpl(`${serviceUrl}/${evidence.reference}`,{headers:serviceToken?{authorization:`Bearer ${serviceToken}`}:{},signal:AbortSignal.timeout(10000),redirect:'error'});
        if(!upstream.ok)return send(res,502,{error:'Evidence unavailable'});
        const reader=upstream.body.getReader();let size=0;const chunks=[];
        while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1000000){await reader.cancel();return send(res,502,{error:'Evidence exceeds limit'});}chunks.push(Buffer.from(value));}
        const bytes=Buffer.concat(chunks);
        if('sha256:'+createHash('sha256').update(bytes).digest('hex')!==evidence.digest)return send(res,502,{error:'Evidence digest mismatch'});
        return send(res,200,JSON.parse(bytes.toString('utf8')));
      }
      if(req.method==='GET'&&/^\/jobs\/[^/]+\/result$/.test(path)){const job=store.get(decodeURIComponent(path.split('/')[2]));return send(res,!job?404:job.result?200:202,job?.result??{requestId:job?.requestId,execution:job?.execution.state??'unknown'});}
      if(req.method==='POST'&&path==='/quotes'){const input=await checkInput(await body(req));if(input.testProfile===DEPENDENCY_PROFILE)return send(res,200,workflow.quote(input,publicUrl));profileFor(input.testProfile);return send(res,200,{id:'quote-'+digest(input),requestDigest:'sha256:'+digest(input),provider:publicUrl,network:'localnet',asset:'USDC',paymentType:'fixed',amount:10000,expiresAt:new Date(Date.now()+300000).toISOString(),testProfile:input.testProfile});}
      if(req.method==='GET'&&path.startsWith('/jobs/')) {const job=store.get(decodeURIComponent(path.slice(6)));return send(res,job?200:404,job??{error:'Not found'});}
      if(req.method!=='POST'||path!=='/investigations')return send(res,404,{error:'Not found'});
      if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`)return send(res,403,{error:'Cross-origin requests refused'});
      const input=await checkInput(await body(req));
      const prior=store.get(input.requestId);
      if(input.testProfile===DEPENDENCY_PROFILE) {
        if(!prior||!['confirmed','pending','unknown'].includes(prior.payment.state))workflow.authorize(input);
      }else profileFor(input.testProfile);
      let job=store.create(input);
      if(['confirmed','pending','unknown'].includes(job.payment.state)||locks.has(job.requestId))return send(res,job.payment.state==='confirmed'?200:202,job);
      locks.add(job.requestId);
      try {
        const headers={'content-type':'application/json'};
        for(const key of proofHeaders)if(req.headers[key])headers[key]=req.headers[key];
        const paying=proofHeaders.some(k=>req.headers[k]);
        if(paying) {store.bindProof(digest(Object.fromEntries(proofHeaders.filter(k=>headers[k]).map(k=>[k,headers[k]]))),job.requestId);job.payment.state='pending';update(job,'authorized','Payment proof submitted; authorization decision belongs to buyer');}
        const response=await fetchImpl(`${gateUrl}/investigations`,{method:'POST',headers,body:JSON.stringify(input),signal:AbortSignal.timeout(30000),redirect:'manual'});
        const raw=await response.text(); job=store.get(job.requestId);
        const forwarded={};for(const key of ['www-authenticate','payment-required','x-payment-required',...evidenceHeaders]) {const value=response.headers.get(key);if(value)forwarded[key]=value;}
        for(const key of evidenceHeaders)if(forwarded[key])job.payment.evidence.push({kind:key,value:forwarded[key],at:new Date().toISOString()});
        if(response.status===402&&!paying){job.payment.state='required';update(job,'payment_required');}
        else if(paying&&job.payment.state!=='confirmed'){job.payment.state='unknown';update(job,'reconciliation_required','Payment attempt returned without confirmed fulfillment');}
        store.save(job);
        if(response.status===402){res.writeHead(402,{'content-type':response.headers.get('content-type')??'application/json',...forwarded});return res.end(raw);}
        return send(res,response.ok?202:502,job,forwarded);
      } catch(error) {if(error.status)return send(res,error.status,{error:error.message});job=store.get(job.requestId);if(job.payment.state==='pending'){job.payment.state='unknown';update(job,'reconciliation_required','Gateway timed out; no automatic payment retry');}return send(res,503,job);}
      finally{locks.delete(job.requestId);}
    } catch(e){send(res,e.status??500,{error:e.message});}
  });
  return {publicServer,privateServer,store,workflow};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  mkdirSync(new URL('../data/',import.meta.url),{recursive:true});
  const app=createGateway({store:new Store(fileURLToPath(new URL('../data/jobs.sqlite',import.meta.url))),gateToken:process.env.INSTALLGUARD_GATE_TOKEN,serviceUrl:process.env.INSTALLGUARD_SERVICE_URL,serviceToken:process.env.INSTALLGUARD_INTERNAL_TOKEN,accessToken:process.env.INSTALLGUARD_ACCESS_TOKEN,publicUrl:process.env.INSTALLGUARD_PUBLIC_URL || 'http://127.0.0.1:4312'});
  app.privateServer.listen(4313,'127.0.0.1');app.publicServer.listen(4312,'127.0.0.1',()=>console.log('InstallGuard timeline: http://127.0.0.1:4312'));
}
