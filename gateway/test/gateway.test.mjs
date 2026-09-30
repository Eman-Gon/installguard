import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGateway} from '../src/server.mjs';
import {Store} from '../src/store.mjs';
import {createHash} from 'node:crypto';
const input={...JSON.parse(readFileSync(new URL('../../fixtures/csv-broken.request.json',import.meta.url))),requestId:'request-123'};
const accessToken='buyer-access-test-only-123456789012345';
const fetch=(url,options={})=>globalThis.fetch(url,{...options,headers:{'x-installguard-token':accessToken,...options.headers}});
const token='test-only-token-1234567890123456789';
async function setup(t,fetchImpl,options={}){const app=createGateway({gateToken:token,accessToken,fetchImpl,...options});app.publicServer.listen(0,'127.0.0.1');app.privateServer.listen(0,'127.0.0.1');await Promise.all([once(app.publicServer,'listening'),once(app.privateServer,'listening')]);t.after(()=>{app.publicServer.close();app.privateServer.close();app.store.close()});const url=`http://127.0.0.1:${app.publicServer.address().port}`;return {...app,url,privateUrl:`http://127.0.0.1:${app.privateServer.address().port}`,post:(data=input,headers={})=>fetch(url+'/investigations',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(data)})};}
test('unpaid requests relay actual challenge, polling never invokes gate, identity conflicts reject',async t=>{let calls=0;const app=await setup(t,async()=>{calls++;return new Response('challenge',{status:402,headers:{'www-authenticate':'Payment test'}})});const response=await app.post();assert.equal(response.status,402);assert.equal(response.headers.get('www-authenticate'),'Payment test');assert.equal((await (await fetch(app.url+'/jobs/request-123')).json()).payment.state,'required');assert.equal(calls,1);assert.equal((await app.post({...input,goal:'changed'})).status,409);assert.equal(calls,1);});
test('verified gateway executes once and repeat POST returns record without payment',async t=>{let calls=0;let app;app=await setup(t,async(url,options)=>{calls++;return fetch(app.privateUrl+'/investigations',{...options,headers:{authorization:`Bearer ${token}`}})});assert.equal((await app.post(input,{'payment-signature':'sandbox-test-proof'})).status,202);await new Promise(r=>setTimeout(r,10));let job=app.store.get(input.requestId);assert.equal(job.payment.state,'confirmed');assert.equal(job.result.fixture,true);assert.equal((await app.post()).status,200);assert.equal(calls,1);assert.equal((await fetch(app.privateUrl+'/investigations',{method:'POST',body:JSON.stringify(input)})).status,401);});
test('ambiguous payment and concurrent retries never resubmit to gate',async t=>{let calls=0;const app=await setup(t,async()=>{calls++;await new Promise(r=>setTimeout(r,20));throw Error('timeout')});await Promise.all([app.post(input,{'payment-signature':'proof'}),app.post(input,{'payment-signature':'proof'})]);assert.equal(app.store.get(input.requestId).payment.state,'unknown');await app.post(input,{'payment-signature':'proof'});assert.equal(calls,1);});
test('restart preserves result and marks interrupted payment/execution unknown',()=>{const path=mkdtempSync(join(tmpdir(),'installguard-test-'));try{const file=join(path,'jobs.sqlite');let store=new Store(file);const job=store.create(input);job.payment.state='pending';job.execution.state='running';store.save(job);store.close();store=new Store(file);assert.equal(store.get(input.requestId).payment.state,'unknown');assert.equal(store.get(input.requestId).execution.state,'unknown');assert.throws(()=>store.create({...input,goal:'changed'}),/different input/);store.close();}finally{rmSync(path,{recursive:true,force:true})}});

test('malformed input cannot incur a payment and quotes are free',async t=>{let calls=0;const app=await setup(t,async()=>{calls++;return new Response('',{status:402})});assert.equal((await app.post({requestId:'malformed'})).status,400);const response=await fetch(app.url+'/quotes',{method:'POST',body:JSON.stringify(input)});assert.equal(response.status,200);assert.equal((await response.json()).amount,10000);assert.equal(calls,0)});
test('payment proof cannot be reused with a different request ID',async t=>{let calls=0;let app;app=await setup(t,async(url,options)=>{calls++;return fetch(app.privateUrl+'/investigations',{...options,headers:{authorization:`Bearer ${token}`}})});await app.post(input,{'payment-signature':'same-proof'});assert.equal((await app.post({...input,requestId:'another-request'},{'payment-signature':'same-proof'})).status,409);assert.equal(calls,1)});
test('late verified callback resolves an ambiguous payment without a fresh charge',async t=>{const app=await setup(t,async()=>{throw Error('response lost')});await app.post(input,{'payment-signature':'late-proof'});assert.equal(app.store.get(input.requestId).payment.state,'unknown');const response=await fetch(app.privateUrl+'/investigations',{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(input)});assert.equal(response.status,202);assert.equal(app.store.get(input.requestId).payment.state,'confirmed');});
test('result endpoint preserves fixture honesty and never invokes payment',async t=>{let app,calls=0;app=await setup(t,async(url,options)=>{calls++;return fetch(app.privateUrl+'/investigations',{...options,headers:{authorization:`Bearer ${token}`}})});await app.post(input,{'payment-signature':'result-proof'});const response=await fetch(app.url+'/jobs/'+input.requestId+'/result');assert.equal(response.status,200);const result=await response.json();assert.equal(result.execution,'not_started');assert.equal(result.exitCode,null);assert.equal(result.fixture,true);assert.equal(calls,1)});

test('evidence retrieval verifies bytes and never invokes payment or a caller-selected URL',async t=>{
  const raw=JSON.stringify({execution:{remote:{provider:'daytona',sandboxId:'sandbox'},exitCode:0}});
  let calls=0;
  const app=await setup(t,async(url,options)=>{calls++;assert.equal(url,'http://service/evidence/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json');assert.equal(options.headers.authorization,'Bearer service-token');return new Response(raw);},{serviceUrl:'http://service',serviceToken:'service-token'});
  const job=app.store.create(input);job.result={evidence:[{reference:'evidence/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json',digest:'sha256:'+createHash('sha256').update(raw).digest('hex')}]};app.store.save(job);
  const response=await fetch(app.url+'/jobs/'+input.requestId+'/evidence');assert.equal(response.status,200);assert.equal((await response.json()).execution.remote.provider,'daytona');assert.equal(calls,1);
  job.result.evidence[0].digest='sha256:'+'0'.repeat(64);app.store.save(job);assert.equal((await fetch(app.url+'/jobs/'+input.requestId+'/evidence')).status,502);
  job.result.evidence[0].reference='../../.env';app.store.save(job);assert.equal((await fetch(app.url+'/jobs/'+input.requestId+'/evidence')).status,404);assert.equal(calls,2);
});

test('gateway reconciliation asks service to retrieve existing remote execution',async t=>{
  let calls=0;
  const app=await setup(t,async(url,options)=>{calls++;assert.equal(url,'http://service/jobs/request-123/reconcile');assert.equal(options.method,'POST');return new Response(JSON.stringify({execution:'unknown'}),{status:202});},{serviceUrl:'http://service'});
  const job=app.store.create(input);job.payment.state='confirmed';job.execution.state='unknown';app.store.save(job);
  const response=await fetch(app.privateUrl+'/reconcile/'+input.requestId,{method:'POST',headers:{authorization:`Bearer ${token}`}});
  assert.equal(response.status,409);assert.equal(calls,1);assert.equal(app.store.get(input.requestId).execution.state,'unknown');
});

 test('job, result, evidence and purchase endpoints reject unauthenticated readers',async t=>{
 const app=await setup(t,async()=>{throw Error('must not contact gate')});app.store.create(input);
 for(const path of ['/jobs','/jobs/request-123','/jobs/request-123/result','/jobs/request-123/evidence','/profiles'])assert.equal((await globalThis.fetch(app.url+path)).status,401);
 assert.equal((await globalThis.fetch(app.url+'/investigations',{method:'POST',body:JSON.stringify(input)})).status,401);
 });

test('wrong artifact digest is rejected before quoting or forwarding payment',async t=>{
 let calls=0;const app=await setup(t,async()=>{calls++;throw Error('must not contact gate')});const changed={...input,artifact:{...input.artifact,digest:'sha256:'+'f'.repeat(64)}};
 assert.equal((await app.post(changed,{'payment-signature':'unused-proof'})).status,400);
 assert.equal((await fetch(app.url+'/quotes',{method:'POST',body:JSON.stringify(changed)})).status,400);assert.equal(calls,0);
});
test('buyer can reconcile without the internal gate token; service errors are contained',async t=>{
 let calls=0;const app=await setup(t,async()=>{calls++;throw Error('Service unavailable')},{serviceUrl:'http://service'});const job=app.store.create(input);job.payment.state='confirmed';job.execution.state='unknown';app.store.save(job);
 assert.equal((await globalThis.fetch(app.url+'/jobs/'+input.requestId+'/reconcile',{method:'POST'})).status,401);
 assert.equal((await fetch(app.url+'/jobs/'+input.requestId+'/reconcile',{method:'POST'})).status,500);assert.equal(calls,1);
});
