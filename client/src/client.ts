import { z } from 'zod';
import { RequestSchema, PolicySchema, QuoteSchema, ResultSchema, type InvestigationRequest, type InvestigationResult } from './contracts.js';
import { canonical, identity } from './identity.js';
import { Ledger } from './ledger.js';
export function checkedResult(raw:unknown,request:InvestigationRequest):InvestigationResult {
 const result=ResultSchema.parse(raw);
 if(result.requestId!==request.requestId || result.requestDigest!==identity(request) || result.artifactDigest!==request.artifact.digest || result.lockfileDigest!==request.lockfileDigest || canonical(result.target)!==canonical(request.target))throw Error('Result identity mismatch');
 if(result.execution==='completed' && result.exitCode===null)throw Error('Completed execution lacks exit code');
 if(result.assessment?.vulnerabilities==='reported')result.installationPolicy='block';
 if(result.fixture || result.execution!=='completed' || result.exitCode!==0 || result.finding!=='not_reproduced_by_this_test' || result.evidence.length===0)result.installationPolicy=result.installationPolicy==='block'?'block':'review';
 return result;
}
export async function investigate(args:{request:unknown,policy:unknown,provider:string,accessToken?:string,resultFixture?:unknown}){
 const request=RequestSchema.parse(args.request),policy=PolicySchema.parse(args.policy);
 if(Date.parse(policy.expiresAt)<=Date.now())throw Error('Authorization expired');
 if(!policy.providers.includes(args.provider))throw Error('Provider not authorized');
 if(!policy.testProfiles.includes(request.testProfile))throw Error('Test profile not authorized');
 if(args.resultFixture!==undefined){
  const result=checkedResult(args.resultFixture,request);
  if(!result.fixture)throw Error('Fixture mode requires fixture:true');
  return {mode:'contract-fixture',payment:{state:'not_requested',executed:false},result};
 }
 const provider=new URL(args.provider);
 if(provider.username||provider.password||provider.search||provider.hash||provider.pathname!=='/')throw Error('Provider must be a bare origin');
 if(provider.protocol!=='https:' && !(provider.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(provider.hostname)))throw Error('Provider requires HTTPS except loopback');
 const response=await fetch(new URL('/investigations',provider),{method:'POST',headers:{'content-type':'application/json','idempotency-key':request.requestId,...(args.accessToken?{'x-installguard-token':args.accessToken}:{})},body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(30_000)});
 if(response.status===402){
  // Never invoke a generic automatic-paying curl wrapper: challenge terms and limits must be verified first.
  return {mode:'http',requestId:request.requestId,payment:{state:'required',executed:false},execution:'not_started',installationPolicy:'review',reason:'Pay adapter unavailable: install and verify sandbox protocol support before authorizing payment'};
 }
 if(!response.ok)throw Error(`Provider HTTP ${response.status}; no payment attempted`);
 const body=await response.json();
 if(body.payment && body.execution){
  const job=z.object({requestId:z.string(),inputDigest:z.string(),payment:z.object({state:z.enum(['not_requested','required','denied','pending','confirmed','unknown'])}),execution:z.object({state:z.enum(['not_started','queued','running','completed','failed','unknown'])}),result:z.unknown().optional()}).parse(body);
  if(job.requestId!==request.requestId||'sha256:'+job.inputDigest!==identity(request))throw Error('Job identity mismatch');
  return {mode:'http',payment:{state:job.payment.state,executed:false,source:'provider-reported'},execution:job.execution.state,installationPolicy:'review',result:job.result?checkedResult(job.result,request):undefined,next:`GET /jobs/${request.requestId}/result`};
 }
 const result=checkedResult(body,request);
 return {mode:'http',payment:{state:'not_requested',executed:false},result};
}
/** Trusted adapter integration seam. It must validate the actual challenge against this quote,
 * enforce fixed sandbox terms, and return a protocol receipt. See pay-adapter.ts. */
export async function authorizedPurchase(args:{request:unknown,policy:unknown,quote:unknown,ledger:Ledger,
 adapter:{execute:(request:InvestigationRequest,quote:ReturnType<typeof QuoteSchema.parse>)=>Promise<{receipt:string,result?:unknown,execution?:string}>}}){
 const request=RequestSchema.parse(args.request),policy=PolicySchema.parse(args.policy),quote=QuoteSchema.parse(args.quote);
 if(quote.testProfile!==request.testProfile)throw Error('Quote scope mismatch');
 const reservation=await args.ledger.reserve(policy,request.requestId,identity(request),quote);
 if(!reservation.fresh)return {payment:{state:reservation.state,receipt:reservation.receipt},execution:'unknown',installationPolicy:'review',reason:'Existing request: retrieve/reconcile job; never charge again'};
 let paid:{receipt:string,result?:unknown,execution?:string};
 try {paid=await args.adapter.execute(request,quote);if(!paid.receipt)throw Error('Missing receipt');}
 catch {await args.ledger.settle(policy,request.requestId,'unknown');return {payment:{state:'unknown'},execution:'unknown',installationPolicy:'review',reason:'Payment outcome ambiguous; allowance remains reserved, do not repurchase'};}
 await args.ledger.settle(policy,request.requestId,'confirmed',paid.receipt);
 // Receipt remains recorded even if provider result is invalid.
 return {payment:{state:'confirmed',receipt:paid.receipt},execution:paid.execution??'unknown',result:paid.result===undefined?undefined:checkedResult(paid.result,request)};
}

/** Free result retrieval only; never submits a payment or creates a job. */
export async function retrieve(args:{request:unknown,policy:unknown,provider:string,accessToken?:string}){
 const request=RequestSchema.parse(args.request),policy=PolicySchema.parse(args.policy);
 if(!policy.providers.includes(args.provider))throw Error('Provider not authorized');
 const provider=new URL(args.provider);
 if(provider.origin!==args.provider || (provider.protocol!=='https:' && !(provider.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(provider.hostname))))throw Error('Invalid provider origin');
 const response=await fetch(new URL(`/jobs/${encodeURIComponent(request.requestId)}/result`,provider),{headers:args.accessToken?{'x-installguard-token':args.accessToken}:{},redirect:'error',signal:AbortSignal.timeout(30_000)});
 if(response.status===202)return {requestId:request.requestId,execution:'pending',paymentExecuted:false,installationPolicy:'review'};
 if(!response.ok)throw Error(`Result retrieval HTTP ${response.status}; no payment attempted`);
 return {paymentExecuted:false,result:checkedResult(await response.json(),request)};
}
