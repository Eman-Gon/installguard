import { agentRun } from './agent.js';
import { Ledger } from './ledger.js';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { artifactDigest, identity, verifyArtifacts } from './identity.js';
import { RequestSchema } from './contracts.js';
import { investigate, retrieve } from './client.js';
const options=Object.fromEntries(['reference','project','lockfile','request','policy','provider','result','package','version','node','arch','goal','id','ledger','profile'].map(k=>[k,{type:'string' as const}]));
async function main(){
 const {values,positionals}=parseArgs({options,allowPositionals:true});
 const need=(name:string)=>{const value=values[name];if(!value)throw Error(`Missing --${name}`);return value;};
 const json=async(name:string)=>JSON.parse(await readFile(need(name),'utf8'));
 switch(positionals[0]){
  case 'doctor': {let result=spawnSync('pay',['--version'],{encoding:'utf8',timeout:5000});if(result.error)result=spawnSync(fileURLToPath(new URL('../../gateway/node_modules/.bin/pay',import.meta.url)),['--version'],{encoding:'utf8',timeout:5000});return {node:process.version,pay:result.status===0?result.stdout.trim():'not installed or unavailable',paymentAdapter:'bounded MPP sandbox adapter',paymentExecuted:false};}
  case 'prepare':{
   const project=need('project'),lockfile=need('lockfile');
   const request=RequestSchema.parse({requestId:values.id??randomUUID(),package:{ecosystem:'npm',name:need('package'),version:need('version')},artifact:{reference:values.reference??project,digest:await artifactDigest(project)},lockfileDigest:await artifactDigest(lockfile),target:{os:'linux',arch:values.arch??'x64',runtime:'node',version:need('node')},goal:need('goal'),testProfile:values.profile??'csv-validation-v1'});
   const lock=JSON.parse(await readFile(lockfile,'utf8'));
   if(lock.packages?.['node_modules/'+request.package.name]?.version!==request.package.version)throw Error('Exact dependency version is absent from npm lockfile packages');
   return request;
  }
  case 'agent': {
   const request=RequestSchema.parse(await json('request'));await verifyArtifacts(need('project'),need('lockfile'),request);
   if(!process.env.INSTALLGUARD_ACCESS_TOKEN)throw Error('INSTALLGUARD_ACCESS_TOKEN required');
   return agentRun({request,policy:await json('policy'),provider:need('provider'),accessToken:process.env.INSTALLGUARD_ACCESS_TOKEN,ledger:new Ledger(need('ledger'))});
  }
  case 'investigate':{
   const request=RequestSchema.parse(await json('request'));await verifyArtifacts(need('project'),need('lockfile'),request);
   return investigate({request,policy:await json('policy'),provider:need('provider'),accessToken:process.env.INSTALLGUARD_ACCESS_TOKEN,resultFixture:values.result?await json('result'):undefined});
  }
  case 'result':return retrieve({request:await json('request'),policy:await json('policy'),provider:need('provider'),accessToken:process.env.INSTALLGUARD_ACCESS_TOKEN});
  case 'identity':return {requestDigest:identity(RequestSchema.parse(await json('request')))};
  default:throw Error('Commands: prepare, agent, investigate, result, identity, doctor. See client/README.md');
 }
}
main().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(JSON.stringify({error:error.message,installationPolicy:'review'}));process.exitCode=1;});
