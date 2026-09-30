// Fixed runner. Input package scripts are disabled; code executes only in the import child.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('/work/project',{recursive:true});
writeFileSync('/work/project/package.json',JSON.stringify({private:true}));
const name=process.argv[2],mode=process.argv[3];
const run=(bin,args)=>{
 const out=spawnSync(bin,args,{cwd:'/work/project',env:{PATH:process.env.PATH,HOME:'/work',npm_config_cache:'/work/cache'},encoding:'utf8',timeout:25000,maxBuffer:65536});
 return {exitCode:out.status,logs:(String(out.stdout||'')+String(out.stderr||'')).slice(0,32768),timedOut:out.error?.code==='ETIMEDOUT'};
};
const install=run('npm',['install','/input/package.tgz','--offline','--ignore-scripts','--no-audit','--no-fund','--package-lock=false','--omit=optional']);
const test=install.exitCode===0?run('node',mode==='module'?['--input-type=module','-e',`await import(${JSON.stringify(name)})`]:['-e',`require(${JSON.stringify(name)})`]):null;
const report={install,test,environment:{os:process.platform,architecture:process.arch,runtime:`node-${process.versions.node}`,isolated:true,mode:'docker'}};
console.log('INSTALLGUARD_DEPENDENCY='+JSON.stringify(report));
