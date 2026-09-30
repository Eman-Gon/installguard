import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Ledger } from '../src/ledger.js';
import { authorizedPurchase, checkedResult, investigate } from '../src/client.js';
import { hash, identity } from '../src/identity.js';
import { RequestSchema, PolicySchema, QuoteSchema } from '../src/contracts.js';
const request=RequestSchema.parse({requestId:'demo-1',package:{ecosystem:'npm',name:'csv-parse',version:'5.6.0'},artifact:{reference:'demo.tar',digest:hash('artifact')},lockfileDigest:hash('lock'),target:{os:'linux',arch:'x64',runtime:'node',version:'22.11.0'},goal:'Reject missing fields',testProfile:'csv-validation-v1'});
const policy=PolicySchema.parse({authorizationId:'demo',providers:['http://127.0.0.1:4000'],network:'localnet',asset:'USDC',paymentType:'fixed',perCallLimit:100,totalLimit:150,expiresAt:'2099-01-01T00:00:00Z',testProfiles:['csv-validation-v1']});
const quote=QuoteSchema.parse({id:'q1',requestDigest:identity(request),provider:policy.providers[0],network:policy.network,asset:policy.asset,paymentType:'fixed',amount:100,expiresAt:policy.expiresAt,testProfile:request.testProfile});
const result={requestId:request.requestId,requestDigest:identity(request),artifactDigest:request.artifact.digest,lockfileDigest:request.lockfileDigest,target:request.target,executionId:'e1',execution:'completed',finding:'not_reproduced_by_this_test',installationPolicy:'allow',exitCode:0,logs:['Fixture only'],evidence:[{reference:'fixture',digest:hash('fixture')}],limitations:['Simulated'],recommendation:'Review',fixture:true};
async function ledger(){const path=join(await mkdtemp(join(tmpdir(),'ig-test-')),'ledger.json');return {path,value:new Ledger(path)};}
test('exact version rejects mutable selectors',()=>{for(const version of ['latest','^5.6.0','5.x'])assert.throws(()=>RequestSchema.parse({...request,package:{...request.package,version}}));});
test('fixture result stays review and no payment executed',async()=>{const out=await investigate({request,policy,provider:policy.providers[0]!,resultFixture:result});assert.equal(out.payment.executed,false);assert.equal(out.result?.installationPolicy,'review');});
test('rejects substituted artifacts and target',()=>{assert.throws(()=>checkedResult({...result,artifactDigest:hash('other')},request));assert.throws(()=>checkedResult({...result,target:{...request.target,arch:'arm64'}},request));});
test('unknown charge reserves budget across restart and duplicate cannot repurchase',async()=>{
 const l=await ledger();let calls=0;const adapter={execute:async()=>{calls++;throw Error('lost response');}};
 const out=await authorizedPurchase({request,policy,quote,ledger:l.value,adapter});assert.equal(out.payment.state,'unknown');
 await authorizedPurchase({request,policy,quote,ledger:new Ledger(l.path),adapter});assert.equal(calls,1);
 const next={...request,requestId:'demo-2'};await assert.rejects(authorizedPurchase({request:next,policy,quote:{...quote,requestDigest:identity(next)},ledger:new Ledger(l.path),adapter}),/Budget/);
});
test('policy disallows provider, amount and expired quotes',async()=>{
 for(const changed of [{provider:'https://evil.example'},{amount:101},{expiresAt:'2020-01-01T00:00:00Z'}]){
  const l=await ledger();await assert.rejects(l.value.reserve(policy,request.requestId,identity(request),{...quote,...changed}));
 }
});
test('stable ID cannot refer to a changed artifact',async()=>{const l=await ledger();await l.value.reserve(policy,request.requestId,identity(request),quote);await assert.rejects(l.value.reserve(policy,request.requestId,hash('changed'),quote),/reused/);});
test('confirmed receipt survives invalid execution result',async()=>{
 const l=await ledger();await assert.rejects(authorizedPurchase({request,policy,quote,ledger:l.value,adapter:{execute:async()=>({receipt:'test-only-receipt',result:{}})}}));
 assert.equal((await l.value.get(policy,request.requestId))?.state,'confirmed');
});
test('concurrent reservations cannot overspend',async()=>{const l=await ledger();const responses=await Promise.allSettled(['a','b'].map(id=>l.value.reserve(policy,id,identity(request),quote)));assert.equal(responses.filter(r=>r.status==='fulfilled').length,1);});
test('real HTTP 402 never triggers payment',async()=>{
 const server=createServer((_req,res)=>{res.writeHead(402);res.end('payment required');});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {const address=server.address();if(!address||typeof address==='string')throw Error();const provider=`http://127.0.0.1:${address.port}`;
 const out=await investigate({request,policy:{...policy,providers:[provider]},provider});assert.equal(out.payment.state,'required');assert.equal(out.payment.executed,false);
 }finally{server.close();}
});
test('provider job envelope preserves paid state without claiming client payment',async()=>{
 const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({requestId:request.requestId,inputDigest:identity(request).slice(7),payment:{state:'confirmed'},execution:{state:'running'}}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const address=server.address();if(!address||typeof address==='string')throw Error();const provider=`http://127.0.0.1:${address.port}`;
 const out=await investigate({request,policy:{...policy,providers:[provider]},provider});assert.equal(out.payment.state,'confirmed');assert.equal(out.payment.executed,false);assert.equal(out.execution,'running');
 }finally{server.close();}
});
