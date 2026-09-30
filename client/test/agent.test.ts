import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Ledger } from '../src/ledger.js';
import { agentRun } from '../src/agent.js';
import { validateChallenge, sandboxPayAdapter } from '../src/pay-adapter.js';
import { identity, hash } from '../src/identity.js';
import { RequestSchema, PolicySchema, QuoteSchema } from '../src/contracts.js';
const request=RequestSchema.parse({requestId:'agent-test',package:{ecosystem:'npm',name:'csv-parse',version:'5.6.0'},artifact:{reference:'csv-broken',digest:hash('artifact')},lockfileDigest:hash('lock'),target:{os:'linux',arch:'x64',runtime:'node',version:'22.11.0'},goal:'Investigate',testProfile:'csv-validation-v1'});
const terms={amount:'10000',currency:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',recipient:'test-recipient',methodDetails:{network:'localnet',decimals:6,feePayer:true}};
const challenge=(changed={})=>`Payment id="challenge-1", method="solana", intent="charge", request="${Buffer.from(JSON.stringify({...terms,...changed})).toString('base64url')}", expires="2099-01-01T00:00:00Z"`;
const receipt=Buffer.from(JSON.stringify({method:'solana',status:'success',reference:'test-only-reference',challengeId:'challenge-1'})).toString('base64url');
const basePolicy={authorizationId:'test-only',providers:['http://127.0.0.1:4000'],network:'localnet',asset:'USDC',paymentType:'fixed',perCallLimit:10000,totalLimit:10000,expiresAt:'2099-01-01T00:00:00Z',testProfiles:['csv-validation-v1']};
const quote=QuoteSchema.parse({id:'quote-1',requestDigest:identity(request),provider:basePolicy.providers[0],network:'localnet',asset:'USDC',paymentType:'fixed',amount:10000,expiresAt:basePolicy.expiresAt,testProfile:request.testProfile});
const result={requestId:request.requestId,requestDigest:identity(request),artifactDigest:request.artifact.digest,lockfileDigest:request.lockfileDigest,target:request.target,executionId:'execution-1',execution:'completed',finding:'reproduced',installationPolicy:'block',exitCode:1,logs:['not ok missing field'],evidence:[{reference:'evidence/test.json',digest:hash('evidence')}],limitations:[],recommendation:'Inspect failing assertion',fixture:true};
const runPay=async(url:string,body:string)=>{const first=await fetch(url,{method:'POST',body});assert.equal(first.status,402);const second=await fetch(url,{method:'POST',body,headers:{authorization:'Payment test-only-proof'}});assert.equal(second.status,200);};
test('rejects changed amount, network, currency, expiration, and duplicate challenge fields',()=>{
 assert.equal(validateChallenge(challenge(),quote),'challenge-1');
 for(const changed of [{amount:'10001'},{currency:'other'},{methodDetails:{network:'mainnet',decimals:6,feePayer:true}}])assert.throws(()=>validateChallenge(challenge(changed),quote));
 assert.throws(()=>validateChallenge(challenge().replace('2099','2000'),quote));
 assert.throws(()=>validateChallenge(challenge()+', method="solana"',quote));
});
test('buyer purchases once, resumes after restart, rejects overspend and records confirmed receipt',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ig-agent-'));t.after(()=>rm(dir,{recursive:true,force:true}));let paid=0;let provider='';
 const server=createServer(async(req,res)=>{
  assert.equal(req.headers['x-installguard-token'],'test-access');res.setHeader('content-type','application/json');
  if(req.url==='/quotes'){res.end(JSON.stringify({...quote,provider}));return;}
  if(req.url?.endsWith('/result')){res.end(JSON.stringify(result));return;}
  if(req.url==='/investigations'){
   if(!req.headers.authorization){res.writeHead(402,{'www-authenticate':challenge()});res.end();return;}
   paid++;res.setHeader('payment-receipt',receipt);
  }
  res.end(JSON.stringify({requestId:request.requestId,inputDigest:identity(request).slice(7),payment:{state:'confirmed',evidence:[{kind:'payment-receipt',value:receipt}]},execution:{state:'running'}}));
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 const address=server.address();if(!address||typeof address==='string')throw Error();provider=`http://127.0.0.1:${address.port}`;
 const policy=PolicySchema.parse({...basePolicy,providers:[provider]});const path=join(dir,'ledger');
 const args={request,policy,provider,accessToken:'test-access',ledger:new Ledger(path),runPay};
 const first=await agentRun(args);assert.equal(first.payment?.state,'confirmed');assert.ok('result' in first);assert.equal(first.result?.installationPolicy,'block');
 await agentRun({...args,ledger:new Ledger(path)});assert.equal(paid,1);
 await assert.rejects(new Ledger(path).reserve(policy,'other',identity(request),{...quote,provider}),/Budget/);
});
test('wrong actual price never reaches signer and retains a conservative reservation',async t=>{
 const server=createServer((_req,res)=>{res.writeHead(402,{'www-authenticate':challenge({amount:'10001'})});res.end();});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 const address=server.address();if(!address||typeof address==='string')throw Error();
 const adapter=sandboxPayAdapter('test-access',async(url,body)=>{const response=await fetch(url,{method:'POST',body});assert.equal(response.status,502);assert.equal(response.headers.get('www-authenticate'),null);});
 await assert.rejects(adapter.execute(request,{...quote,provider:`http://127.0.0.1:${address.port}`}),/unknown/);
});
test('OS releases ledger transaction after a killed process; pending allowance survives',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ig-crash-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'ledger');const policy=PolicySchema.parse(basePolicy),ledger=new Ledger(path);
 await ledger.reserve(policy,request.requestId,identity(request),quote);
 const child=spawn(process.execPath,['--experimental-sqlite','--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');console.log('locked');setInterval(()=>{},1000);`,path+'.sqlite'],{stdio:['ignore','pipe','pipe']});
 await once(child.stdout,'data');child.kill('SIGKILL');await once(child,'exit');
 assert.equal((await new Ledger(path).get(policy,request.requestId))?.state,'pending');
 await assert.rejects(new Ledger(path).reserve(policy,'next',identity(request),quote),/Budget/);
});
test('legacy uncertain reservations migrate without restoring allowance',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ig-legacy-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'ledger'),policy=PolicySchema.parse(basePolicy);
 await writeFile(path,JSON.stringify({policyDigest:identity(policy),entries:{old:{requestDigest:identity(request),quoteDigest:identity(quote),amount:10000,state:'unknown'}}}));
 assert.equal((await new Ledger(path).get(policy,'old'))?.state,'unknown');
 await assert.rejects(new Ledger(path).reserve(policy,'next',identity(request),quote),/Budget/);
});

test('an unknown purchase reconciles a stored receipt without invoking Pay or a new quote',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ig-reconcile-'));t.after(()=>rm(dir,{recursive:true,force:true}));let provider='',reads=0;
 const server=createServer((req,res)=>{
  assert.equal(req.method,'GET');reads++;res.setHeader('content-type','application/json');
  res.end(JSON.stringify(req.url?.endsWith('/result')?result:{requestId:request.requestId,inputDigest:identity(request).slice(7),payment:{state:'confirmed',evidence:[{kind:'payment-receipt',value:receipt}]},execution:{state:'completed'}}));
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());const address=server.address();if(!address||typeof address==='string')throw Error();provider=`http://127.0.0.1:${address.port}`;
 const policy=PolicySchema.parse({...basePolicy,providers:[provider]}),ledger=new Ledger(join(dir,'ledger'));
 await ledger.reserve(policy,request.requestId,identity(request),{...quote,provider});await ledger.settle(policy,request.requestId,'unknown');
 const out=await agentRun({request,policy,provider,accessToken:'test-access',ledger,runPay:async()=>{throw Error('must not pay');}});
 assert.equal(out.payment?.state,'confirmed');assert.equal((await ledger.get(policy,request.requestId))?.state,'confirmed');assert.equal(reads,2);
});

test('modified payload and repeated paid submissions are rejected at the bridge',async t=>{
 let calls=0;const server=createServer((req,res)=>{calls++;if(!req.headers.authorization){res.writeHead(402,{'www-authenticate':challenge()});res.end();return;}res.writeHead(200,{'payment-receipt':receipt});res.end(JSON.stringify({requestId:request.requestId,inputDigest:identity(request).slice(7),payment:{state:'confirmed'},execution:{state:'queued'}}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());const address=server.address();if(!address||typeof address==='string')throw Error();
 const adapter=sandboxPayAdapter('token',async(url,body)=>{
  assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,502);
  assert.equal((await fetch(url,{method:'POST',body})).status,402);
  assert.equal((await fetch(url,{method:'POST',body,headers:{authorization:'Payment test'}})).status,200);
  assert.equal((await fetch(url,{method:'POST',body,headers:{authorization:'Payment test'}})).status,502);
 });
 await adapter.execute(request,{...quote,provider:`http://127.0.0.1:${address.port}`});assert.equal(calls,2);
});
