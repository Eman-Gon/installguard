import { RequestSchema, PolicySchema, QuoteSchema } from './contracts.js';
import { identity } from './identity.js';
import { Ledger } from './ledger.js';
import { authorizedPurchase, retrieve } from './client.js';
import { sandboxPayAdapter, validateReceipt, type PayRunner } from './pay-adapter.js';
/** An agent may call this repeatedly. Existing reservations only take the read/reconcile path. */
export async function agentRun(args:{request:unknown,policy:unknown,provider:string,accessToken:string,ledger:Ledger,approvedQuote?:unknown,maxPolls?:number,pollMs?:number,runPay?:PayRunner,diagnostic?:(message:string)=>void}){
 const request=RequestSchema.parse(args.request),policy=PolicySchema.parse(args.policy);
 if(!policy.providers.includes(args.provider))throw Error('Provider not authorized');
 const url=new URL(args.provider);
 if(url.origin!==args.provider||url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Sandbox purchase requires loopback provider');
 const headers={'content-type':'application/json','x-installguard-token':args.accessToken};
 let existing=await args.ledger.get(policy,request.requestId);
 if(existing&&existing.requestDigest!==identity(request))throw Error('Request ID reused with different artifacts');
 let payment:{state:string,receipt?:string}|undefined;
 if(!existing){
  const response=args.approvedQuote ? null : await fetch(args.provider+'/quotes',{method:'POST',headers,body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(10_000)});
  if(response&&!response.ok)throw Error('Quote unavailable; no payment attempted');
  const quote=QuoteSchema.parse(args.approvedQuote ?? await response!.json());
  if(quote.provider!==args.provider)throw Error('Quote provider mismatch');
  const purchase=await authorizedPurchase({request,policy,quote,ledger:args.ledger,adapter:sandboxPayAdapter(args.accessToken,args.runPay,args.diagnostic)});
  payment=purchase.payment;
  if('result' in purchase&&purchase.result)return purchase;
 }
 existing=await args.ledger.get(policy,request.requestId);
 if(existing){
  // No paid POST, no new quote, and no budget release on missing evidence.
  const response=await fetch(args.provider+'/jobs/'+encodeURIComponent(request.requestId),{headers,redirect:'error',signal:AbortSignal.timeout(10_000)});
  if(response.ok){
   const job=await response.json();
   if(job.requestId!==request.requestId||'sha256:'+job.inputDigest!==identity(request))throw Error('Reconciliation identity mismatch');
   if(job.payment?.state==='confirmed'&&job.execution?.state==='unknown'){
    await fetch(args.provider+'/jobs/'+encodeURIComponent(request.requestId)+'/reconcile',{method:'POST',headers,redirect:'error',signal:AbortSignal.timeout(15_000)});
   }
   const evidence=job.payment?.evidence?.find((e:{kind:string})=>e.kind==='payment-receipt');
   if(existing.state!=='confirmed'&&existing.state!=='denied'&&job.payment?.state==='confirmed'&&evidence?.value){
    const receipt=validateReceipt(evidence.value);await args.ledger.settle(policy,request.requestId,'confirmed',receipt);payment={state:'confirmed',receipt};
   }
  }
 }
 payment??={state:existing?.state??'unknown',receipt:existing?.receipt};
 const polls=Math.max(1,Math.min(args.maxPolls??10,60));
 for(let i=0;i<polls;i++){
  const out=await retrieve({request,policy,provider:args.provider,accessToken:args.accessToken});
  if('result' in out)return {payment,...out};
  if(i+1<polls)await new Promise(resolve=>setTimeout(resolve,Math.max(10,Math.min(args.pollMs??1000,5000))));
 }
 return {payment,execution:'pending',installationPolicy:'review',reason:'Poll limit reached; resume with the same request ID and ledger. No repeat purchase.'};
}
