import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { InvestigationRequest, Quote } from './contracts.js';
import { identity } from './identity.js';
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export function validateChallenge(header:string,quote:Quote){
 if(!header.startsWith('Payment '))throw Error('Only MPP charge is supported');
 const fields:Record<string,string>={};let rest=header.slice(8);
 while(rest){const match=/^([a-zA-Z][\w]*)="([^"\\]*)"(?:,\s*|$)/.exec(rest);if(!match||fields[match[1]!])throw Error('Invalid or ambiguous MPP challenge');fields[match[1]!]=match[2]!;rest=rest.slice(match[0].length);}
 if(fields.method!=='solana'||fields.intent!=='charge'||!fields.id||!fields.request||!fields.expires||!Number.isFinite(Date.parse(fields.expires))||Date.parse(fields.expires)<=Date.now())throw Error('Unsupported or expired charge');
 const terms=JSON.parse(Buffer.from(fields.request,'base64url').toString('utf8'));
 if(quote.network!=='localnet'||quote.asset!=='USDC'||quote.paymentType!=='fixed'||terms.amount!==String(quote.amount)||terms.currency!==USDC||terms.methodDetails?.network!=='localnet'||terms.methodDetails?.decimals!==6||terms.methodDetails?.feePayer!==true||!terms.recipient)throw Error('Actual challenge differs from authorized sandbox quote');
 if(Date.parse(quote.expiresAt)<=Date.now())throw Error('Quote expired');
 return fields.id;
}
export function validateReceipt(encoded:string,challengeId?:string){
 let receipt;try{receipt=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));}catch{throw Error('Invalid MPP receipt');}
 if(receipt.method!=='solana'||receipt.status!=='success'||typeof receipt.reference!=='string'||!receipt.reference||typeof receipt.challengeId!=='string'||!receipt.challengeId||(challengeId&&receipt.challengeId!==challengeId))throw Error('Unsuccessful or mismatched MPP receipt');
 return encoded;
}
export type PayRunner=(url:string,body:string)=>Promise<void>;
export const runSandboxPay:PayRunner=async(url,body)=>{
 const directory=await mkdtemp(join(tmpdir(),'installguard-pay-'));
 try {
 const bodyFile=join(directory,'request.json');await writeFile(bodyFile,body,{mode:0o600});
 await new Promise<void>((resolve,reject)=>{
 // This adapter cannot select a mainnet wallet, change destinations, or run a shell.
 const child=spawn('pay',['--sandbox','curl','--silent','--show-error','--max-time','90','--request','POST','--header','content-type: application/json','--data-binary','@'+bodyFile,url],{detached:true,stdio:['pipe','pipe','pipe']});
 const stop=()=>{try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
 let bytes=0;const timer=setTimeout(()=>{stop();reject(Error('Pay timed out; reconcile before retrying'));},95_000);
 const consume=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>2_000_000){stop();reject(Error('Pay output limit exceeded'));}};
 child.stdout.on('data',consume);child.stderr.on('data',consume);
 child.on('error',()=>{clearTimeout(timer);reject(Error('Pay executable unavailable'));});
 child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Pay failed; reconcile existing request'));});
 child.stdin.on('error',()=>{});child.stdin.end();
 });
 }finally{await rm(directory,{recursive:true,force:true});}
};
/** A one-purchase loopback bridge validates EVERY challenge before Pay can sign it. */
export function sandboxPayAdapter(accessToken:string,run:PayRunner=runSandboxPay,diagnostic:(message:string)=>void=()=>{}){
 return {execute:async(request:InvestigationRequest,quote:Quote)=>{
  const origin=new URL(quote.provider);
  if(origin.origin!==quote.provider||origin.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(origin.hostname))throw Error('Sandbox adapter requires a loopback provider');
  const payload=JSON.stringify(request),path='/'+randomUUID();
  let challengeId:string|undefined,submitted=false,receipt:string|undefined,result:unknown,execution:string|undefined;
  let busy=false;
  const bridge=createServer(async(req,res)=>{
   const fail=()=>{if(!res.headersSent)res.writeHead(502);res.end('Payment bridge rejected response; reconcile existing job');};
   if(req.method!=='POST'||req.url!==path||busy){res.writeHead(403);res.end();return;}
   busy=true;
   try{
    let body='';for await(const chunk of req){body+=chunk;if(body.length>131072)throw Error('Body limit');}
    if(body!==payload)throw Error('Request changed');
    const proof=req.headers.authorization;
    if(submitted|| (proof&&!challengeId))throw Error('Duplicate or unsolicited payment');
    if(proof)submitted=true;
    const upstream=await fetch(new URL('/investigations',origin),{method:'POST',body:payload,headers:{'content-type':'application/json','x-installguard-token':accessToken,...(proof?{authorization:proof}:{})},redirect:'error',signal:AbortSignal.timeout(30_000)});
    diagnostic(`upstream HTTP ${upstream.status}; proof submitted: ${!!proof}`);
    if(upstream.status===402){
     if(proof||challengeId)throw Error('Repeated payment challenge');
     challengeId=validateChallenge(upstream.headers.get('www-authenticate')||'',quote);
     res.writeHead(402,{'www-authenticate':upstream.headers.get('www-authenticate')!});res.end('Payment required');return;
    }
    if(!upstream.ok)throw Error('Provider unavailable');
    const job=await upstream.json();
    if(job.requestId!==request.requestId||'sha256:'+job.inputDigest!==identity(request))throw Error('Job identity mismatch');
    const encoded=upstream.headers.get('payment-receipt');
    if(!encoded||!submitted||job.payment?.state!=='confirmed')throw Error('No confirmed receipt');
    receipt=validateReceipt(encoded,challengeId);result=job.result??undefined;execution=job.execution?.state;
    res.writeHead(200,{'content-type':'application/json','payment-receipt':receipt});res.end(JSON.stringify(job));
   }catch(error){diagnostic(error instanceof Error?error.message:'Bridge error');fail();}finally{busy=false;}
  });
  try{
   await new Promise<void>((resolve,reject)=>{bridge.once('error',reject);bridge.listen(0,'127.0.0.1',resolve);});
   const address=bridge.address();if(!address||typeof address==='string')throw Error('Bridge unavailable');
   await run(`http://127.0.0.1:${address.port}${path}`,payload);
   if(!receipt)throw Error('Payment outcome unknown');
   return {receipt,result,execution};
  }finally{bridge.closeAllConnections();await new Promise<void>(resolve=>bridge.close(()=>resolve()));}
 }};
}
