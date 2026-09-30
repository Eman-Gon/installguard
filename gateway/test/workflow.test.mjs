import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGateway } from '../src/server.mjs';
import { Workflow } from '../src/workflow.mjs';
import { Store } from '../src/store.mjs';
import { identity, hash } from '../../shared/identity.mjs';
const context={projectId:'a'.repeat(64),moduleType:'module',nodeMajor:22};
export const request={requestId:'dependency-test',package:{ecosystem:'npm',name:'csv-parse',version:'5.6.0'},context,artifact:{reference:'dependency-check',digest:identity(context)},lockfileDigest:hash('none'),target:{os:'linux',arch:'arm64',runtime:'node',version:'22.11.0'},goal:'Check before installation',testProfile:'node-dependency-v1'};
const accessToken='buyer-access-test-123456789012345',gateToken='private-gate-test-123456789012345';
async function setup(t,mode='challenge') {
 let calls=0,app;
 app=createGateway({accessToken,gateToken,fetchImpl:async(url,options)=>{calls++;if(mode==='unknown')throw Error('lost response');if(mode==='paid')return fetch(`http://127.0.0.1:${app.privateServer.address().port}/investigations`,{...options,headers:{authorization:'Bearer '+gateToken}});return new Response('',{status:402});}});
 for(const server of [app.publicServer,app.privateServer]){server.listen(0,'127.0.0.1');await once(server,'listening');}
 t.after(()=>{app.publicServer.closeAllConnections();app.publicServer.close();app.privateServer.closeAllConnections();app.privateServer.close();app.store.close();});
 const url=`http://127.0.0.1:${app.publicServer.address().port}`;
 const api=(path,method='GET',body,headers={})=>fetch(url+path,{method,headers:{'x-installguard-token':accessToken,...headers},body:body===undefined?undefined:JSON.stringify(body)});
 return {...app,api,calls:()=>calls};
}
test('default OFF, ON alone, decline, expired quote and altered price cannot charge',async t=>{
 const app=await setup(t);
 assert.equal((await app.api('/quotes','POST',request)).status,403);
 await app.api('/projects/'+context.projectId,'PUT',{enabled:true});
 const quote=await (await app.api('/quotes','POST',request)).json();
 assert.equal(app.calls(),0);
 assert.equal((await app.api('/investigations','POST',request)).status,403);
 const path='/approvals/'+quote.id+'/decision';
 assert.equal((await app.api(path,'POST',{decision:'approve',amount:10000})).status,403);
 const human={origin:'http://127.0.0.1:4312','x-installguard-human':'dashboard'};
 assert.equal((await app.api(path,'POST',{decision:'approve',amount:20000},human)).status,400);
 await app.api(path,'POST',{decision:'decline',amount:10000},human);
 assert.equal((await app.api('/investigations','POST',request)).status,403);
 assert.equal(app.calls(),0);
 const second={...request,requestId:'expired'};const q=app.workflow.quote(second,'http://127.0.0.1:4312');
 const entry=app.workflow.get(q.id);entry.quote.expiresAt='2000-01-01T00:00:00Z';
 app.store.db.prepare('UPDATE approvals SET data=? WHERE id=?').run(JSON.stringify(entry),q.id);
 assert.throws(()=>app.workflow.decide(q.id,'approve',10000),/expired/);
});
test('OFF revokes approvals, preserves history, and re-enabling does not reapprove',async t=>{
 const app=await setup(t);app.workflow.set(context.projectId,true);const q=app.workflow.quote(request,'http://127.0.0.1:4312');app.workflow.decide(q.id,'approve',10000);
 app.workflow.set(context.projectId,false);
 assert.equal((await app.api('/investigations','POST',request)).status,403);
 assert.equal(app.workflow.get(q.id).state,'revoked');app.workflow.set(context.projectId,true);
 assert.equal((await app.api('/investigations','POST',request)).status,403);assert.equal(app.calls(),0);
});
test('approved payment submits once; repeated requests and OFF retrieval do not charge',async t=>{
 const app=await setup(t,'paid');app.workflow.set(context.projectId,true);const q=app.workflow.quote(request,'http://127.0.0.1:4312');app.workflow.decide(q.id,'approve',10000);
 assert.equal((await app.api('/investigations','POST',request,{'payment-signature':'test-proof'})).status,202);
 assert.equal((await app.api('/investigations','POST',request)).status,200);
 app.workflow.set(context.projectId,false);
 assert.equal((await app.api('/jobs/'+request.requestId)).status,200);assert.equal(app.calls(),1);
 assert.equal((await app.api('/investigations','POST',{...request,goal:'altered'})).status,409);
});
test('uncertain payment retains reservation and blocks replacement quotes',async t=>{
 const app=await setup(t,'unknown');app.workflow.set(context.projectId,true);const q=app.workflow.quote(request,'http://127.0.0.1:4312');app.workflow.decide(q.id,'approve',10000);
 await app.api('/investigations','POST',request,{'payment-signature':'test-proof'});
 assert.equal(app.store.get(request.requestId).payment.state,'unknown');
 await app.api('/investigations','POST',request,{'payment-signature':'test-proof'});assert.equal(app.calls(),1);
 assert.throws(()=>app.workflow.quote({...request,requestId:'replacement'},'http://127.0.0.1:4312'),/reconciliation/);
});
test('settings and quote decisions survive restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ig-settings-'));try{const path=join(dir,'db.sqlite');let store=new Store(path),flow=new Workflow(store.db);flow.set(context.projectId,true);const quote=flow.quote(request,'http://127.0.0.1:4312');flow.decide(quote.id,'decline',10000);store.close();store=new Store(path);flow=new Workflow(store.db);assert.equal(flow.settings(context.projectId).enabled,true);assert.equal(flow.get(quote.id).state,'declined');store.close();}finally{await rm(dir,{recursive:true,force:true});}
});
test('OFF between initial challenge and proof prevents forwarding the paid retry',async t=>{
 const app=await setup(t);app.workflow.set(context.projectId,true);const quote=app.workflow.quote(request,'http://127.0.0.1:4312');app.workflow.decide(quote.id,'approve',10000);
 assert.equal((await app.api('/investigations','POST',request)).status,402);
 app.workflow.set(context.projectId,false);
 assert.equal((await app.api('/investigations','POST',request,{'payment-signature':'must-not-forward'})).status,403);
 assert.equal(app.calls(),1);assert.equal(app.store.get(request.requestId).payment.state,'required');
});
