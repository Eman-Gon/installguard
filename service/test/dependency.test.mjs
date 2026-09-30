import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runDependency, dependencyVerdict, boundedFetch } from '../../worker/dependency.mjs';
import { identity, hash } from '../../shared/identity.mjs';
const context={projectId:'a'.repeat(64),moduleType:'module',nodeMajor:22};
const request={requestId:'dep',package:{ecosystem:'npm',name:'csv-parse',version:'5.6.0'},context,artifact:{reference:'dependency-check',digest:identity(context)},lockfileDigest:hash('none'),target:{os:'linux',arch:'arm64',runtime:'node',version:'22.11.0'},goal:'Check',testProfile:'node-dependency-v1'};
const bytes=Buffer.from('test-only-tarball');
const metadata={name:'csv-parse',version:'5.6.0',dist:{tarball:'https://registry.npmjs.org/csv-parse/-/csv-parse-5.6.0.tgz',integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64')}};
const fakeFetch=async url=>new Response(url.endsWith('.tgz')?bytes:JSON.stringify(metadata));
test('Docker unavailable is unknown, without registry fetch or host npm execution',async()=>{
 const calls=[];const run=await runDependency(request,{run:async(bin,args)=>{calls.push([bin,args]);return {exitCode:1,logs:'Docker unavailable'};},fetchImpl:()=>{throw Error('must not fetch');}});
 assert.equal(calls.length,1);assert.equal(calls[0][0],'docker');
 const verdict=dependencyVerdict(request,run,{status:'unavailable'});assert.equal(verdict.dependencyChecks.installation,'unknown');assert.equal(verdict.dependencyChecks.compatibility,'unknown');assert.equal(verdict.dependencyChecks.vulnerabilities,'unknown');assert.equal(verdict.installationPolicy,'review');
});
test('supported run enforces offline nonroot Docker limits, immutable image and cleanup',async()=>{
 const commands=[];const run=await runDependency(request,{fetchImpl:fakeFetch,run:async(bin,args)=>{
  commands.push([bin,args]);assert.equal(bin,'docker');
  if(args[0]==='image')return {exitCode:0,logs:'sha256:'+'f'.repeat(64)};
  if(args[0]==='rm')return {exitCode:0,logs:''};
  for(const flag of ['--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=1000:1000','--pids-limit=64','--memory=384m','--cpus=1'])assert.ok(args.includes(flag));
  assert.ok(!args.some(x=>x.includes('.env')));
  return {exitCode:0,logs:'INSTALLGUARD_DEPENDENCY='+JSON.stringify({install:{exitCode:0,logs:'installed'},test:{exitCode:0,logs:'imported'},environment:{os:'linux',architecture:'arm64',runtime:'node-22.11.0',isolated:true}})};
 }});
 assert.equal(commands.at(-1)[1][0],'rm');assert.equal(run.outcome,'passed');
 const verdict=dependencyVerdict(request,run,{status:'unavailable'});assert.equal(verdict.dependencyChecks.compatibility,'passed');assert.equal(verdict.dependencyChecks.vulnerabilities,'unknown');assert.equal(verdict.installationPolicy,'review');
});
test('unsupported dependencies and foreign tarballs never start a container',async()=>{
 for(const changes of [{dependencies:{foo:'1.0.0'}},{peerDependencies:{foo:'*'}},{dist:{...metadata.dist,tarball:'https://evil.example/a.tgz'}},{dist:{...metadata.dist,integrity:'sha512-'+Buffer.alloc(64).toString('base64')}}]){
 let commands=0;const run=await runDependency(request,{fetchImpl:async url=>new Response(url.endsWith('.tgz')?bytes:JSON.stringify({...metadata,...changes})),run:async()=>{commands++;return {exitCode:0,logs:'sha256:'+'f'.repeat(64)};}});
 assert.equal(commands,1);assert.equal(run.outcome,'inconclusive');
 }
});
test('registry response bounds reject excessive bytes',async()=>{
 await assert.rejects(boundedFetch('https://registry.npmjs.org/x',3,async()=>new Response('1234')),/limit/);
});
test('failed import, wrong architecture and reported advisories remain distinct',()=>{
 const run={install:{exitCode:0},test:{exitCode:1},environment:{os:'linux',architecture:'arm64',runtime:'node-22.11.0',isolated:true}};
 let verdict=dependencyVerdict(request,run,{status:'queried',vulns:[{id:'TEST-1'}]});assert.equal(verdict.dependencyChecks.installation,'passed');assert.equal(verdict.dependencyChecks.compatibility,'failed');assert.equal(verdict.dependencyChecks.vulnerabilities,'reported');assert.equal(verdict.installationPolicy,'block');
 verdict=dependencyVerdict(request,{...run,environment:{...run.environment,architecture:'x64'}},{status:'queried',vulns:[]});assert.equal(verdict.dependencyChecks.compatibility,'unknown');assert.equal(verdict.assessment.environmentVerified,false);
});
test('container timeouts are cleaned up and never become passing evidence',async()=>{
 let removed=false;const run=await runDependency(request,{fetchImpl:fakeFetch,run:async(_bin,args)=>{
  if(args[0]==='image')return {exitCode:0,logs:'sha256:'+'f'.repeat(64)};
  if(args[0]==='rm'){removed=true;return {exitCode:0,logs:''};}
  return {exitCode:null,timedOut:true,logs:'timed out'};
 }});
 assert.equal(removed,true);assert.equal(run.outcome,'inconclusive');assert.equal(dependencyVerdict(request,run,{status:'unavailable'}).dependencyChecks.compatibility,'unknown');
});
