import { realpath, readFile, lstat, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { identity, hash } from '../../shared/identity.mjs';
import { DEPENDENCY_PROFILE, validateDependency } from '../../shared/dependency.mjs';
import { openApproval } from '../../shared/open-approval.mjs';
import { agentRun } from './agent.ts';
import { Ledger } from './ledger.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
export async function projectIdentity(project) {return hash(await realpath(project)).slice(7);}
async function safeRead(path,limit,optional=false) {
 try{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)throw Error('Project metadata must be a bounded regular file');return await readFile(path);}catch(e){if(optional&&e.code==='ENOENT')return null;throw e;}
}
export async function projectContext(project) {
 const directory=await realpath(project),pkg=JSON.parse((await safeRead(resolve(directory,'package.json'),256000)).toString());
 // Neither scripts, dependency lists, names, paths, source, nor environment files leave the project.
 const context={projectId:await projectIdentity(directory),moduleType:pkg.type==='module'?'module':'commonjs',nodeMajor:22};
 const lock=await safeRead(resolve(directory,'package-lock.json'),4*1024*1024,true);
 return {context,lockfileDigest:hash(lock||'no-package-lock'),artifact:{reference:'dependency-check',digest:identity(context)}};
}
export class Integration {
 constructor({provider='http://127.0.0.1:4312',accessToken=process.env.INSTALLGUARD_ACCESS_TOKEN,stateDirectory=resolve(root,'client/.installguard/projects'),fetchImpl=fetch,run=agentRun,openQuote=openApproval}={}) {
  const url=new URL(provider);if(url.origin!==provider||url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Only loopback sandbox providers are supported');
  this.provider=provider;this.accessToken=accessToken;this.stateDirectory=stateDirectory;this.fetch=fetchImpl;this.run=run;this.openQuote=openQuote;
 }
 async api(path,method='GET',data) {
  if(!this.accessToken)throw Error('INSTALLGUARD_ACCESS_TOKEN required');
  const response=await this.fetch(this.provider+path,{method,headers:{'content-type':'application/json','x-installguard-token':this.accessToken},body:data===undefined?undefined:JSON.stringify(data),redirect:'error',signal:AbortSignal.timeout(15000)});
  const result=await response.json();if(!response.ok)throw Error(result.error||`Provider HTTP ${response.status}`);return result;
 }
 async settings({project,enabled}) {const id=await projectIdentity(project);return this.api('/projects/'+id,enabled===undefined?'GET':'PUT',enabled===undefined?undefined:{enabled});}
 async quote({project,package:pkg,version}) {
  if(!(await this.settings({project})).enabled)return {status:'off',charged:false,message:'InstallGuard is OFF. No check requested.'};
  const collected=await projectContext(project);
  const request={requestId:'dependency-'+randomUUID(),package:{ecosystem:'npm',name:pkg,version},...collected,target:{os:'linux',arch:process.arch==='arm64'?'arm64':'x64',runtime:'node',version:'22.11.0'},goal:`Check ${pkg}@${version} before installation; installation requires separate approval.`,testProfile:DEPENDENCY_PROFILE};
  validateDependency(request);
  const quote=await this.api('/quotes','POST',request);
  const item=await this.api('/approvals/'+quote.id);
  const navigation=await this.openQuote(this.provider,quote.id);
  return {status:item.state,quote,requestId:item.request.requestId,...navigation,question:`Would you like InstallGuard to check ${pkg}@${version} before installation? It costs ${(quote.amount/1e6).toFixed(2)} sandbox USDC.`,instructions:'The browser opening was requested automatically unless disabled or unavailable. Show approvalUrl as a fallback. Wait for explicit human approval in the dashboard. Then call submit with this quoteId. Never approve on the user’s behalf. Installation needs separate approval.',scope:'Public npm packages without dependencies. Docker-only install with scripts disabled and Node import/require check. Unavailable checks are unknown.'};
 }
 async item({project,quoteId}) {
  const item=await this.api('/approvals/'+encodeURIComponent(quoteId));if(item.request.context.projectId!==await projectIdentity(project))throw Error('Quote belongs to another project');return item;
 }
 async submit(args) {
  const item=await this.item(args);
  const existing=await this.api('/jobs').then(jobs=>jobs.find(job=>job.requestId===item.request.requestId));
  if(existing&&['confirmed','pending','unknown'].includes(existing.payment.state))return this.result(args);
  if(!(await this.settings(args)).enabled)return {status:'off',charged:false};
  if(!['approved','submitted'].includes(item.state))return {status:item.state,charged:false,message:'No purchase: exact quote requires human approval.'};
  const current=await projectContext(args.project);
  if(identity(current.context)!==item.request.artifact.digest||current.lockfileDigest!==item.request.lockfileDigest)throw Error('Project context changed; approval is not valid for this revision');
  if(Date.parse(item.quote.expiresAt)<=Date.now())throw Error('Approved quote expired; no payment attempted');
  const directory=resolve(this.stateDirectory,item.request.context.projectId,item.quote.id);
  await mkdir(directory,{recursive:true,mode:0o700});
  const outcome=await this.run({request:item.request,policy:item.policy,approvedQuote:item.quote,provider:this.provider,accessToken:this.accessToken,ledger:new Ledger(resolve(directory,'budget')),maxPolls:30,pollMs:1000});
  return {...outcome,dashboardUrl:this.provider+'/#request='+item.request.requestId,installationApproval:false,next:'Present actual findings, unavailable checks, recommendations and receipt. Ask separately before installing.'};
 }
 async result(args) {
  const item=await this.item(args);
  const job=await this.api('/jobs/'+encodeURIComponent(item.request.requestId));
  if('sha256:'+hashIdentity(job.input)!==item.quote.requestDigest)throw Error('Result request identity mismatch');
  return {requestId:job.requestId,payment:job.payment,execution:job.execution,result:job.result,dashboardUrl:this.provider+'/#request='+job.requestId,installationApproval:false,next:'Installation requires separate user approval. Unknown payment must not be retried under a new ID.'};
 }
}
const hashIdentity=value=>identity(value).slice(7);
const properties={project:{type:'string',description:'Absolute path to the current Node project'}};
export const toolDefinitions=[
 {name:'installguard_settings',description:'Read or change this project’s persistent ON/OFF setting. Default OFF. ON does not authorize spending.',inputSchema:{type:'object',properties:{...properties,enabled:{type:'boolean'}},required:['project'],additionalProperties:false}},
 {name:'installguard_quote',description:'Free exact-version quote; collects only minimal Node metadata and lockfile hash. Ask the returned question and wait for the human approval in the dashboard.',inputSchema:{type:'object',properties:{...properties,package:{type:'string'},version:{type:'string'}},required:['project','package','version'],additionalProperties:false}},
 ...['submit','result'].map(action=>({name:'installguard_'+action,description:action==='submit'?'Purchase only an already human-approved quote, using bounded sandbox payment; never installs into the user project.':'Retrieve existing findings, limitations and payment evidence; never charges.',inputSchema:{type:'object',properties:{...properties,quoteId:{type:'string'}},required:['project','quoteId'],additionalProperties:false}}))
];
export async function callTool(client,name,args) {
 const definition=toolDefinitions.find(t=>t.name===name);if(!definition)throw Error('Unknown tool');
 if(!args||typeof args!=='object'||Array.isArray(args))throw Error('Tool arguments required');
 for(const key of definition.inputSchema.required)if(typeof args[key]!=='string'||!args[key])throw Error('Missing '+key);
 for(const key of Object.keys(args))if(!(key in definition.inputSchema.properties))throw Error('Unexpected argument '+key);
 if('enabled' in args&&typeof args.enabled!=='boolean')throw Error('enabled must be boolean');
 return client[name.replace('installguard_','')](args);
}
async function main() {
 // Load the service's credentials, never the target project's .env.
 if(!process.env.INSTALLGUARD_ACCESS_TOKEN){try{const content=await readFile(resolve(root,'.env'),'utf8');const value=content.match(/^INSTALLGUARD_ACCESS_TOKEN=(.*)$/m)?.[1]?.trim();if(value)process.env.INSTALLGUARD_ACCESS_TOKEN=value.replace(/^(['"])(.*)\1$/,'$2');}catch(e){if(e.code!=='ENOENT')throw e;}}
 const client=new Integration();
 if(process.argv[2]==='mcp') {
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of lines){let message;try {
   if(Buffer.byteLength(line)>32768)throw Error('Message too large');message=JSON.parse(line);
   if(message.id===undefined)continue;
   let result;
   if(message.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'installguard',version:'0.1.0'}};
   else if(message.method==='ping')result={};
   else if(message.method==='tools/list')result={tools:toolDefinitions};
   else if(message.method==='tools/call'){try{result={content:[{type:'text',text:JSON.stringify(await callTool(client,message.params.name,message.params.arguments))}]};}catch(e){result={isError:true,content:[{type:'text',text:e.message}]};}}
   else throw Error('Unsupported method');
   process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');
  }catch(e){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message?.id??null,error:{code:-32600,message:e.message}})+'\n');}}
  return;
 }
 const {values,positionals}=parseArgs({allowPositionals:true,options:Object.fromEntries(['project','package','version','quoteId','enabled'].map(k=>[k,{type:'string'}]))});
 if(values.enabled!==undefined){if(!['on','off'].includes(values.enabled))throw Error('--enabled must be on or off');values.enabled=values.enabled==='on';}
 console.log(JSON.stringify(await callTool(client,'installguard_'+positionals[0],values),null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
