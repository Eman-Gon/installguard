import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Integration, projectContext, callTool, toolDefinitions } from '../src/integration.mjs';
async function project(t){const dir=await mkdtemp(join(tmpdir(),'ig-project-'));t.after(()=>rm(dir,{recursive:true,force:true}));await writeFile(join(dir,'package.json'),JSON.stringify({name:'private-project',type:'module',scripts:{test:'secret command'},dependencies:{private:'git+ssh://secret'}}));await writeFile(join(dir,'.env'),'SECRET=do-not-send');return dir;}
test('context collection excludes secrets, paths, source, scripts and dependency list',async t=>{
 const dir=await project(t);const context=await projectContext(dir);const text=JSON.stringify(context);for(const secret of ['SECRET','private','secret command',dir])assert.ok(!text.includes(secret));assert.equal(context.context.moduleType,'module');
 await symlink(join(dir,'.env'),join(dir,'package-lock.json'));await assert.rejects(projectContext(dir),/regular file/);
});
test('OFF exits before collecting project metadata or requesting a quote',async t=>{
 const dir=await project(t);await rm(join(dir,'package.json'));let requests=0;
 const client=new Integration({accessToken:'test',fetchImpl:async()=>{requests++;return new Response(JSON.stringify({enabled:false}));},run:()=>{throw Error('must not pay');}});
 const out=await client.quote({project:dir,package:'csv-parse',version:'5.6.0'});assert.equal(out.status,'off');assert.equal(requests,1);
});
test('there is no agent approval tool or installation tool; undeclared parameters rejected',async()=>{
 assert.equal(toolDefinitions.length,4);assert.ok(!toolDefinitions.some(t=>/approve|install_package/.test(t.name)));
 await assert.rejects(callTool({},'installguard_submit',{project:'/x',quoteId:'q',approved:true}),/Unexpected/);
});
test('declined check never invokes payment client',async t=>{
 const dir=await project(t),context=await projectContext(dir);let called=false;
 const client=new Integration({accessToken:'test',fetchImpl:async url=>new Response(JSON.stringify(url.includes('/approvals/')?{state:'declined',request:{requestId:'x',...context}}:url.endsWith('/jobs')?[]:{enabled:true})),run:()=>{called=true;}});
 assert.equal((await client.submit({project:dir,quoteId:'q'})).status,'declined');assert.equal(called,false);
});
