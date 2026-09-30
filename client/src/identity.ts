import { readFile, readdir, lstat } from 'node:fs/promises';
import { hash } from '../../shared/identity.mjs';
export { canonical, hash, identity } from '../../shared/identity.mjs';
export async function verifyArtifacts(project:string,lockfile:string,request:{artifact:{digest:string},lockfileDigest:string}) {
  const lock=await readFile(lockfile);
  if(await artifactDigest(project)!==request.artifact.digest || hash(lock)!==request.lockfileDigest) throw Error('Artifact or lockfile digest mismatch');
}

/** Controlled demo directory manifest; archive files are hashed byte-for-byte. */
export async function artifactDigest(path:string):Promise<string>{
 const stat=await lstat(path);
 if(stat.isSymbolicLink())throw Error('Artifact symlinks are unsupported');
 if(stat.isFile())return hash(await readFile(path));
 const names=(await readdir(path)).filter(n=>n!=='node_modules').sort();
 const files=[];
 for(const name of names){
  const file=path+'/'+name,info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink())throw Error('Controlled demo artifacts must contain only regular root-level files');
  files.push({path:name,sha256:hash(await readFile(file)).slice(7)});
 }
 return hash(JSON.stringify(files));
}
