import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {History,failureSignature} from '../history.mjs';
import {assess} from '../verdict.mjs';
import {identity as serviceIdentity} from '../identity.mjs';
import {digest as gatewayDigest} from '../../gateway/src/store.mjs';
const request={package:{name:'csv-parse',version:'5.6.0'},artifact:{digest:'artifact-a'},testProfile:'csv-validation-v1',target:{os:'linux',arch:'x64',runtime:'node',version:'22.11.0'}};
const run={outcome:'failed',exitCode:1,test:{logs:'not ok 1 - rejects missing name\n  error: required name\n  code: ERR_ASSERTION'},environment:{os:'linux',architecture:'x64',runtime:'node-22.11.0',isolated:true}};
test('history survives restart, deduplicates executions, counts artifacts and never changes verdict',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ig-history-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'patterns.sqlite');let history=new History(path);
 const result={executionId:'one',evidence:[{reference:'evidence/one.json',digest:'digest'}]};const analysis={execution:run,osv:{status:'unavailable'},narrative:'suggestion only'};
 history.record(request,result,analysis);history.record(request,result,analysis);
 history.record({...request,artifact:{digest:'artifact-b'}},{...result,executionId:'two'},analysis);
 history=new History(path);const context=history.context(request,failureSignature(run));assert.equal(context.patterns[0].occurrences,2);assert.equal(context.patterns[0].artifacts,2);
 assert.deepEqual(history.context({...request,package:{...request.package,version:'other'}}).patterns,[]);
 assert.equal(assess(request,{...run,history:context},analysis.osv).installationPolicy,'block');
 assert.equal(assess(request,{...run,outcome:'passed',history:context},analysis.osv).installationPolicy,'review');
});
test('signature ignores test index, paths and duration noise but distinguishes assertions',()=>{
 const signature=failureSignature(run);assert.equal(signature,failureSignature({...run,test:{logs:run.test.logs.replace('not ok 1','not ok 7')+'\n duration_ms: 222'}}));
 assert.notEqual(signature,failureSignature({...run,test:{logs:run.test.logs.replaceAll('name','email')}}));
 assert.equal(failureSignature({outcome:'failed',logs:'unknown exit'}),null);
});
test('verdict separates installation, environment, vulnerabilities and functional evidence',()=>{
 const unavailable={status:'unavailable'};
 const install=assess(request,{outcome:'inconclusive',install:{exitCode:1}},unavailable);assert.equal(install.assessment.failureKind,'installation');assert.equal(install.finding,'inconclusive');assert.doesNotMatch(install.recommendation,/CSV/);
 const passed={...run,outcome:'passed',exitCode:0};assert.equal(assess(request,passed,unavailable).installationPolicy,'review');
 const vulnerable=assess(request,passed,{status:'queried',vulns:[{id:'TEST-ADVISORY'}]});assert.equal(vulnerable.installationPolicy,'block');assert.equal(vulnerable.assessment.vulnerabilities,'reported');
 assert.equal(assess(request,{...passed,environment:{isolated:false}},unavailable).finding,'inconclusive');
});
test('gateway and service hash nested identity fields identically',()=>{
 const value={b:[{z:3,a:'text'}],a:{os:'linux',arch:'arm64'}};assert.equal(serviceIdentity(value),'sha256:'+gatewayDigest(value));
});
