import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createGateway } from '../gateway/src/server.mjs';
import { JobStore } from '../service/jobs.mjs';
import { agentRun } from '../client/src/agent.ts';
import { Ledger } from '../client/src/ledger.ts';
const directory=await mkdtemp(join(tmpdir(),'installguard-smoke-'));
const listen=async(server)=>{server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;};
const token=randomBytes(32).toString('hex'),accessToken=randomBytes(32).toString('hex');
const jobs=new JobStore(join(directory,'jobs'),{workerMode:'local-development',offline:true});
const service=createServer(async(req,res)=>{try{let body='';for await(const chunk of req)body+=chunk;const result=await jobs.submit(JSON.parse(body));res.setHeader('content-type','application/json');res.end(JSON.stringify(result));}catch{res.writeHead(500);res.end('{}');}});
let app,gate;
try{
 const serviceUrl=await listen(service);
 const portServer=createServer();const gateUrl=await listen(portServer);await new Promise(resolve=>portServer.close(resolve));
 app=createGateway({gateToken:token,accessToken,serviceUrl,gateUrl});
 const privateUrl=await listen(app.privateServer),provider=await listen(app.publicServer);
 // Quotes advertise the actual ephemeral public origin.
 // Recreate with the allocated origin before any requests.
 await Promise.all([new Promise(r=>app.publicServer.close(r)),new Promise(r=>app.privateServer.close(r))]);app.store.close();
 app=createGateway({gateToken:token,accessToken,serviceUrl,gateUrl,publicUrl:provider});
 app.publicServer.listen(Number(new URL(provider).port),'127.0.0.1');app.privateServer.listen(Number(new URL(privateUrl).port),'127.0.0.1');
 await Promise.all([once(app.publicServer,'listening'),once(app.privateServer,'listening')]);
 const spec=(await readFile(new URL('../gateway/paywall.yml',import.meta.url),'utf8')).replace('http://127.0.0.1:4313/',privateUrl+'/');
 const specFile=join(directory,'paywall.yml');await writeFile(specFile,spec);
 gate=spawn('pay',['--sandbox','gate','api',specFile,'--bind',new URL(gateUrl).host,'--no-register'],{detached:true,env:{...process.env,INSTALLGUARD_GATE_TOKEN:token},stdio:['ignore','pipe','pipe']});
 let gateLog='';gate.stdout.on('data',c=>{gateLog=(gateLog+c).slice(-4000);});gate.stderr.on('data',c=>{gateLog=(gateLog+c).slice(-4000);});
 gate.on('error',()=>{});
 let ready=false;
 for(let i=0;i<100;i++){if(gate.exitCode!==null)throw Error('Sandbox gateway exited before readiness');try{await fetch(gateUrl+'/health',{signal:AbortSignal.timeout(300)});ready=true;break;}catch{await new Promise(r=>setTimeout(r,200));}}
 if(!ready)throw Error('Sandbox gateway did not become ready');
 const policy={authorizationId:'smoke-'+randomUUID(),providers:[provider],network:'localnet',asset:'USDC',paymentType:'fixed',perCallLimit:10000,totalLimit:20000,expiresAt:new Date(Date.now()+600000).toISOString(),testProfiles:['csv-validation-v1']};
 const ledger=new Ledger(join(directory,'buyer-ledger'));const summaries=[];
 for(const reference of ['csv-broken','csv-fixed']){
  const request=JSON.parse(await readFile(new URL(`../fixtures/${reference}.request.json`,import.meta.url)));request.requestId='smoke-'+randomUUID();
  const result=await agentRun({request,policy,provider,accessToken,ledger,maxPolls:30,diagnostic:message=>console.error('Bridge:',message)});
  assert.equal(result.payment.state,'confirmed',JSON.stringify(result));assert.ok(result.result,'Result missing');assert.equal(result.result.exitCode,reference==='csv-broken'?1:0);
  const repeated=await agentRun({request,policy,provider,accessToken,ledger:new Ledger(join(directory,'buyer-ledger'))});
  assert.equal(repeated.result.executionId,result.result.executionId);
  assert.equal(app.store.get(request.requestId).events.filter(e=>e.state==='paid').length,1);
  summaries.push({artifact:reference,requestId:request.requestId,requestDigest:result.result.requestDigest,artifactDigest:result.result.artifactDigest,executionId:result.result.executionId,receipt:JSON.parse(Buffer.from(result.payment.receipt,'base64url').toString('utf8')),payment:result.payment.state,execution:result.result.execution,exitCode:result.result.exitCode,policy:result.result.installationPolicy,replaySameExecution:true,assessment:result.result.assessment});
 }
 console.log(JSON.stringify({verifiedAt:new Date().toISOString(),paymentNetwork:'localnet',workerMode:'local-development',mainnetFundsSpent:false,results:summaries},null,2));
}finally{
 if(gate?.pid){try{process.kill(-gate.pid,'SIGTERM');}catch{}await Promise.race([once(gate,'close'),new Promise(r=>setTimeout(r,2000))]);try{process.kill(-gate.pid,'SIGKILL');}catch{}}
 service.closeAllConnections();service.close();if(app){app.publicServer.closeAllConnections();app.privateServer.closeAllConnections();app.publicServer.close();app.privateServer.close();app.store.close();}
 await rm(directory,{recursive:true,force:true});
}
