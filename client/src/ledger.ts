import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { identity } from './identity.js';
import type { Policy, Quote } from './contracts.js';
export type PaymentState='pending'|'confirmed'|'unknown'|'denied';
type Entry={requestDigest:string,quoteDigest:string,quote:Quote,amount:number,state:PaymentState,receipt?:string};
type Data={policyDigest:string,entries:Record<string,Entry>};
/** SQLite releases its transaction lock on process death. Uncertain charges stay reserved. */
export class Ledger {
 constructor(private path:string){}
 private transaction<T>(policy:Policy,fn:(data:Data)=>T):T{
  mkdirSync(dirname(this.path),{recursive:true,mode:0o700});
  const db=new DatabaseSync(this.path+'.sqlite');
  try {
   chmodSync(this.path+'.sqlite',0o600);
   db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL); BEGIN IMMEDIATE');
   const row=db.prepare('SELECT data FROM ledger WHERE id=1').get() as {data:string}|undefined;
   let data:Data;
   if(row)data=JSON.parse(row.data);
   else {
    // Never guess whether an old-version writer is still alive.
    if(existsSync(this.path+'.lock'))throw Error('Legacy ledger lock requires manual reconciliation before migration');
    data=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):{policyDigest:identity(policy),entries:{}};
   }
   if(data.policyDigest!==identity(policy))throw Error('Authorization differs from this ledger; do not reset a live allowance');
   const result=fn(data);
   db.prepare('INSERT INTO ledger VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(data));
   db.exec('COMMIT');return result;
  } catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
 }
 async get(policy:Policy,id:string){return this.transaction(policy,data=>data.entries[id]);}
 async reserve(policy:Policy,requestId:string,requestDigest:string,quote:Quote){
  return this.transaction(policy,data=>{
   const existing=data.entries[requestId];
   if(existing){if(existing.requestDigest!==requestDigest || existing.quoteDigest!==identity(quote))throw Error('Request ID reused with different artifacts or quote');return {fresh:false,...existing};}
   if(Date.parse(policy.expiresAt)<=Date.now() || Date.parse(quote.expiresAt)<=Date.now())throw Error('Authorization or quote expired');
   if(!policy.providers.includes(quote.provider)||policy.network!==quote.network||policy.asset!==quote.asset||policy.paymentType!==quote.paymentType||!policy.testProfiles.includes(quote.testProfile))throw Error('Payment terms not authorized');
   if(quote.requestDigest!==requestDigest)throw Error('Quote request mismatch');
   const spent=Object.values(data.entries).filter(e=>e.state!=='denied').reduce((sum,e)=>sum+BigInt(e.amount),0n);
   if(quote.amount>policy.perCallLimit || spent+BigInt(quote.amount)>BigInt(policy.totalLimit))throw Error('Budget denied');
   const entry:Entry={requestDigest,quoteDigest:identity(quote),quote,amount:quote.amount,state:'pending'};data.entries[requestId]=entry;return {fresh:true,...entry};
  });
 }
 async settle(policy:Policy,id:string,state:PaymentState,receipt?:string){return this.transaction(policy,data=>{
  const entry=data.entries[id];if(!entry)throw Error('Missing reservation');
  if(entry.state==='confirmed'||entry.state==='denied')throw Error('Payment is terminal');
  if(state==='confirmed'&&!receipt)throw Error('Confirmation requires payment evidence');
  entry.state=state;if(receipt)entry.receipt=receipt;return entry;
 });}
}
