import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from './run.mjs';
import { validateDependency } from '../shared/dependency.mjs';
const registry='https://registry.npmjs.org';
export async function boundedFetch(url,limit,fetchImpl=fetch) {
 const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{accept:'application/json'}});
 if(!response.ok)throw Error(`npm registry HTTP ${response.status}`);
 if(Number(response.headers.get('content-length'))>limit)throw Error('Registry response exceeds limit');
 const reader=response.body.getReader();let size=0;const chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('Registry response exceeds limit');chunks.push(Buffer.from(value));}}finally{await reader.cancel();}
 return Buffer.concat(chunks);
}
export async function runDependency(request,{run=command,fetchImpl=fetch}={}) {
 validateDependency(request);
 const startedAt=new Date().toISOString();
 const unavailable=reason=>({startedAt,finishedAt:new Date().toISOString(),outcome:'inconclusive',exitCode:null,logs:reason,limitations:[reason],dependency:true});
 const image=await run('docker',['image','inspect','--format','{{.Id}}','node:22.11.0-slim']);
 const imageId=image.logs.trim();
 if(image.exitCode!==0||!/^sha256:[a-f0-9]{64}$/.test(imageId))return unavailable('Docker or the pinned node:22.11.0-slim image is unavailable. No dependency code ran; no host fallback.');
 let work;
 try {
  const metadata=JSON.parse((await boundedFetch(`${registry}/${encodeURIComponent(request.package.name)}/${encodeURIComponent(request.package.version)}`,512000,fetchImpl)).toString());
  if(metadata.name!==request.package.name||metadata.version!==request.package.version)throw Error('Registry identity mismatch');
  // Version one deliberately supports dependency-free packages only, without a resolver or registry access in the worker.
  if(Object.keys(metadata.dependencies||{}).length||Object.keys(metadata.optionalDependencies||{}).length||Object.keys(metadata.peerDependencies||{}).length||metadata.bundleDependencies?.length||metadata.bundledDependencies?.length)return unavailable('This profile supports packages without dependencies, peers, optional or bundled dependencies. Installation and compatibility are unknown.');
  const tarball=new URL(metadata.dist?.tarball);
  if(tarball.origin!==registry||tarball.username||tarball.password||tarball.search||tarball.hash)throw Error('Only direct npm registry tarballs are supported');
  const integrity=metadata.dist?.integrity;
  if(!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity||''))throw Error('A SHA-512 registry integrity digest is required');
  const bytes=await boundedFetch(tarball.href,8*1024*1024,fetchImpl);
  if('sha512-'+createHash('sha512').update(bytes).digest('base64')!==integrity)throw Error('Package integrity mismatch');
  work=await mkdtemp(join(tmpdir(),'installguard-dependency-'));await chmod(work,0o755);
  await writeFile(join(work,'package.tgz'),bytes,{mode:0o444});
  const name='installguard-dependency-'+randomUUID();
  const args=['run','--rm','--name',name,'--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=64','--memory=384m','--cpus=1','--user=1000:1000','--tmpfs','/work:rw,nosuid,size=192m,mode=1777','--tmpfs','/tmp:rw,noexec,nosuid,size=16m,mode=1777','--mount',`type=bind,src=${work},dst=/input,readonly`,'--mount',`type=bind,src=${fileURLToPath(new URL('./dependency-entry.mjs',import.meta.url))},dst=/runner.mjs,readonly`,imageId,'node','/runner.mjs',request.package.name,request.context.moduleType];
  let executed;
  try{executed=await run('docker',args);}finally{await run('docker',['rm','-f',name]);}
  const marker='INSTALLGUARD_DEPENDENCY=';
  if(executed.exitCode!==0||executed.timedOut||!executed.logs.includes(marker))return unavailable('Isolated worker did not return a complete result. '+executed.logs.slice(-2000));
  const report=JSON.parse(executed.logs.slice(executed.logs.lastIndexOf(marker)+marker.length).trim());
  if(!report.install||!report.environment)throw Error('Invalid isolated evidence');
  report.environment.imageDigest=imageId;
  const outcome=report.test?.exitCode===0?'passed':Number.isInteger(report.test?.exitCode)?'failed':'inconclusive';
  return {...report,dependency:true,startedAt,finishedAt:new Date().toISOString(),outcome,exitCode:report.test?.exitCode??report.install.exitCode,logs:[report.install.logs,report.test?.logs].filter(Boolean).join('\n'),packageIntegrity:integrity,controls:{network:'none',memoryMiB:384,cpus:1,pids:64,wallTimeSeconds:90,lifecycleScripts:false},limitations:['Only installation with lifecycle scripts disabled and a Node import/require smoke check were attempted. Application behavior, browser support, lifecycle scripts, native builds and transitive dependencies are not verified.','Docker isolation is defense in depth, not proof that a package is safe.']};
 }catch(error){return unavailable(error.message);}finally{if(work)await rm(work,{recursive:true,force:true});}
}
export function dependencyVerdict(request,run,osv) {
 const installation=run.install?.exitCode===0?'passed':Number.isInteger(run.install?.exitCode)?'failed':'unknown';
 const environmentVerified=run.environment?.isolated===true&&run.environment?.runtime===`node-${request.target.version}`&&run.environment?.os===request.target.os&&run.environment?.architecture===request.target.arch;
 const compatibility=!environmentVerified?'unknown':run.test?.exitCode===0?'passed':Number.isInteger(run.test?.exitCode)?'failed':'unknown';
 const ids=osv.status==='queried'?(osv.vulns||[]).map(v=>v.id).filter(v=>typeof v==='string'):[];
 const vulnerabilities=osv.status!=='queried'?'unknown':ids.length?'reported':'none_reported';
 const unavailable=['Application integration tests','Lifecycle scripts and native builds','Transitive dependency analysis'];
 if(installation==='unknown')unavailable.push('Package installation');if(compatibility==='unknown')unavailable.push('Target Node import/require compatibility');if(vulnerabilities==='unknown')unavailable.push('Exact-version vulnerability lookup');
 const recommendations=['Ask the user separately before installing. Payment approval does not authorize installation.'];
 if(installation==='failed'||compatibility==='failed'||ids.length)recommendations.unshift('Do not install until the reported failures or advisories have been reviewed.');
 else recommendations.unshift('Review the recorded scope and unavailable checks. A pass is not a security clearance.');
 return {finding:installation==='failed'||compatibility==='failed'?'reproduced':compatibility==='passed'?'not_reproduced_by_this_test':'inconclusive',installationPolicy:installation==='failed'||compatibility==='failed'||ids.length?'block':'review',recommendation:recommendations.join(' '),assessment:{functional:compatibility==='unknown'?'not_completed':compatibility,vulnerabilities,vulnerabilityIds:ids,environmentVerified,failureKind:installation==='failed'?'installation':compatibility==='failed'?'functional':compatibility==='unknown'?'infrastructure':null},dependencyChecks:{installation,compatibility,vulnerabilities,scope:['Exact public npm package/version','Install without lifecycle scripts','Node 22.11.0 import or require smoke check','Exact-version OSV lookup when available'],unavailable,recommendations}};
}
