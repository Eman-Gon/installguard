/** Deterministic replay of the agent repair demonstrated in examples/demo-evidence.
 * Requires Person 2's explicit local-development service; this does not execute payments. */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactDigest } from './identity.js';
import { RequestSchema, PolicySchema } from './contracts.js';
import { investigate } from './client.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const runId=randomUUID(),directory=resolve(root,'client/.installguard',runId),project=resolve(directory,'project');
await mkdir(directory,{recursive:true});await cp(resolve(root,'fixtures/csv-broken'),project,{recursive:true,filter:source=>!source.includes('node_modules')});
const provider=process.env.INSTALLGUARD_DEMO_PROVIDER??'http://127.0.0.1:4315';
if(!['http://127.0.0.1:4315','http://localhost:4315'].includes(provider))throw Error('Demo only supports its dedicated loopback development service');
const policy=PolicySchema.parse({authorizationId:'unpaid-development-'+runId,providers:[provider],network:'localnet',asset:'USDC',paymentType:'fixed',perCallLimit:0,totalLimit:0,expiresAt:new Date(Date.now()+3600000).toISOString(),testProfiles:['csv-validation-v1']});
async function run(reference:string){
 const request=RequestSchema.parse({requestId:runId+'-'+reference,package:{ecosystem:'npm',name:'csv-parse',version:'5.6.0'},artifact:{reference,digest:await artifactDigest(project)},lockfileDigest:await artifactDigest(resolve(project,'package-lock.json')),target:{os:'linux',arch:'x64',runtime:'node',version:'22.11.0'},goal:'Reject missing required CSV fields',testProfile:'csv-validation-v1'});
 const outcome=await investigate({request,policy,provider});await writeFile(resolve(directory,reference+'.json'),JSON.stringify({request,outcome},null,2));return outcome;
}
const before=await run('csv-broken');
if(before.result?.exitCode!==1||!before.result.logs.some(log=>log.includes('Missing expected exception')))throw Error('Expected missing-field failure not observed; no repair applied');
const source=await readFile(resolve(project,'import.mjs'),'utf8');
const repaired=source.replace('  return parse(text, { columns: true, skip_empty_lines: true });',"  const rows = parse(text, { columns: true, skip_empty_lines: true });\n  for (const row of rows) {\n    if (!row.name?.trim() || !row.email?.trim()) throw new Error('name and email are required');\n  }\n  return rows;");
if(source===repaired)throw Error('Controlled source changed; repair no longer applies');
await writeFile(resolve(project,'import.mjs'),repaired);
const after=await run('csv-fixed');
console.log(JSON.stringify({mode:'deterministic-replay-of-agent-repair',paymentExecuted:false,before:before.result?.exitCode,after:after.result?.exitCode,installationPolicy:after.result?.installationPolicy,limitations:after.result?.limitations,evidenceDirectory:directory},null,2));
if(after.result?.exitCode!==0)process.exitCode=1;
