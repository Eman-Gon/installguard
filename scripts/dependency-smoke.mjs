// Scripted acceptance test: simulates the human approval event. Not a live coding-agent session.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createGateway } from '../gateway/src/server.mjs';
import { JobStore } from '../service/jobs.mjs';
import { Integration } from '../client/src/integration.mjs';
const directory=await mkdtemp(join(tmpdir(),'installguard-dependency-smoke-'));
const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;};
const gateToken=randomBytes(32).toString('hex'),accessToken=randomBytes(32).toString('hex');
const jobs=new JobStore(join(directory,'jobs'),{workerMode:'local-development',offline:true});
const service=createServer(async(req,res)=>{try{let body='';for await(const chunk of req)body+=chunk;res.setHeader('content-type','application/json');res.end(JSON.stringify(await jobs.submit(JSON.parse(body))));}catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}});
let app,gate;
try {
 const serviceUrl=await listen(service);
 const portServer=createServer();const gateUrl=await listen(portServer);await new Promise(r=>portServer.close(r));
 app=createGateway({gateToken,accessToken,serviceUrl,gateUrl});const privateUrl=await listen(app.privateServer),provider=await listen(app.publicServer);
 await Promise.all([new Promise(r=>app.publicServer.close(r)),new Promise(r=>app.privateServer.close(r))]);app.store.close();
 app=createGateway({gateToken,accessToken,serviceUrl,gateUrl,publicUrl:provider});app.publicServer.listen(Number(new URL(provider).port),'127.0.0.1');app.privateServer.listen(Number(new URL(privateUrl).port),'127.0.0.1');await Promise.all([once(app.publicServer,'listening'),once(app.privateServer,'listening')]);
 const spec=(await readFile(new URL('../gateway/paywall.yml',import.meta.url),'utf8')).replace('http://127.0.0.1:4313/',privateUrl+'/');
 await writeFile(join(directory,'paywall.yml'),spec);
 gate=spawn('pay',['--sandbox','gate','api',join(directory,'paywall.yml'),'--bind',new URL(gateUrl).host,'--no-register'],{detached:true,env:{...process.env,INSTALLGUARD_GATE_TOKEN:gateToken},stdio:['ignore','pipe','pipe']});
 gate.stdout.resume();gate.stderr.resume();
 let ready=false;for(let i=0;i<100;i++){try{await fetch(gateUrl+'/health',{signal:AbortSignal.timeout(300)});ready=true;break;}catch{await new Promise(r=>setTimeout(r,200));}}
 assert.ok(ready,'Sandbox gateway unavailable');
 await writeFile(join(directory,'package.json'),JSON.stringify({private:true,type:'module'}));
 await writeFile(join(directory,'.env'),'SECRET=not-to-be-sent');
 const client=new Integration({provider,accessToken,stateDirectory:join(directory,'ledgers')});
 assert.equal((await client.quote({project:directory,package:'is-number',version:'7.0.0'})).status,'off');
 await client.settings({project:directory,enabled:true});
 const declined=await client.quote({project:directory,package:'is-number',version:'7.0.0'});
 app.workflow.decide(declined.quote.id,'decline',declined.quote.amount);
 assert.equal((await client.submit({project:directory,quoteId:declined.quote.id})).status,'declined');assert.equal(app.store.list().length,0);
 const quoted=await client.quote({project:directory,package:'is-number',version:'7.0.0'});
 assert.equal((await client.submit({project:directory,quoteId:quoted.quote.id})).charged,false);
 app.workflow.decide(quoted.quote.id,'approve',quoted.quote.amount); // Explicitly a test fixture approval.
 const args={project:directory,quoteId:quoted.quote.id};
 const first=await client.submit(args);assert.equal(first.payment.state,'confirmed');assert.ok(first.result);assert.equal(first.result.fixture,false);
 const replay=await client.submit(args);assert.equal(replay.result.executionId,first.result.executionId);
 assert.equal(app.store.get(quoted.requestId).events.filter(e=>e.state==='paid').length,1);
 const dashboardJobs=await client.api('/jobs');assert.ok(dashboardJobs.some(j=>j.requestId===quoted.requestId&&j.result?.dependencyChecks));
 await client.settings({project:directory,enabled:false});assert.equal((await client.result(args)).payment.state,'confirmed');
 console.log(JSON.stringify({mode:'scripted acceptance; simulated human approval; real sandbox payment',mainnetFundsSpent:false,requestId:quoted.requestId,payment:first.payment,checks:first.result.dependencyChecks,environmentVerified:first.result.assessment.environmentVerified,dashboardSameRequest:true,replaySameExecution:true,offAndDeclineCharged:false,installationApproval:false},null,2));
} finally {
 if(gate?.pid){try{process.kill(-gate.pid,'SIGTERM');}catch{}await Promise.race([once(gate,'close'),new Promise(r=>setTimeout(r,2000))]);try{process.kill(-gate.pid,'SIGKILL');}catch{}}
 service.closeAllConnections();service.close();jobs.history.close?.();if(app){app.publicServer.closeAllConnections();app.privateServer.closeAllConnections();app.publicServer.close();app.privateServer.close();app.store.close();}
 await rm(directory,{recursive:true,force:true});
}
