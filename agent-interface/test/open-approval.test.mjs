import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openApproval, approvalUrl } from '../../shared/open-approval.mjs';
import { AgentInterface } from '../core.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identity } from '../../shared/identity.mjs';

test('opens the exact local quote with native arguments on each supported OS', async () => {
  for (const [platform, command] of [['darwin','/usr/bin/open'],['linux','xdg-open'],['win32','explorer.exe']]) {
    const result = await openApproval('http://127.0.0.1:4312', 'quote-test-123', { platform, enabled:true, run: (file,args,options,callback) => {
      assert.equal(file,command);assert.deepEqual(args,['http://127.0.0.1:4312/#approve=quote-test-123']);
      assert.ok(!options.shell);assert.equal(options.timeout,3000);callback(null);
    } });
    assert.equal(result.browserOpen,'requested');
  }
});

test('headless, disabled, timed-out, and unavailable launchers preserve the link', async () => {
  const failed = await openApproval('http://localhost:4312','quote-test',{enabled:true,run:(_file,_args,_options,callback)=>callback(Error('unavailable'))});
  assert.equal(failed.browserOpen,'unavailable');assert.equal(failed.approvalUrl,'http://localhost:4312/#approve=quote-test');
  assert.equal((await openApproval('http://localhost:4312','quote-test',{enabled:false,run:()=>assert.fail('must not launch')})).browserOpen,'disabled');
  assert.equal((await openApproval('http://localhost:4312','quote-test',{enabled:true,platform:'other'})).browserOpen,'unavailable');
  assert.equal((await openApproval('http://localhost:4312','quote-test',{enabled:true,run:()=>{throw Error('spawn failure');}})).browserOpen,'unavailable');
});

test('rejects remote/credential-bearing origins and malformed quote IDs before launching', () => {
  for(const provider of ['https://example.com','http://user:secret@localhost:4312','http://localhost:4312/?token=secret'])assert.throws(()=>approvalUrl(provider,'quote-test'));
  for(const id of ['../secret','quote-abc&token=secret','quote-abc\n'])assert.throws(()=>approvalUrl('http://localhost:4312',id));
});

test('a successful free quote opens once; OFF and failed quotes do not open', async t => {
  const directory=await mkdtemp(join(tmpdir(),'installguard-open-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));await writeFile(join(directory,'package.json'),'{}');
  let enabled=false,fail=false,opens=0;
  const client=new AgentInterface({project:directory,provider:'http://localhost:4312',accessToken:'test-access-token-1234567890',dataDirectory:directory,
    fetchImpl:async(url,options)=>{
      if(url.includes('/projects/'))return Response.json({enabled});
      if(fail)return Response.json({error:'unavailable'},{status:503});
      return Response.json({id:'quote-open-test',provider:'http://localhost:4312',requestDigest:identity(JSON.parse(options.body)),network:'localnet',asset:'USDC',paymentType:'fixed',amount:10000});
    },openQuote:async(provider,id)=>{opens++;return {approvalUrl:approvalUrl(provider,id),browserOpen:'requested'};}});
  const proposal={package:'is-number',version:'7.0.0',goal:'Check before installation'};
  assert.equal((await client.quote(proposal)).state,'disabled');assert.equal(opens,0);
  enabled=true;const quote=await client.quote(proposal);
  assert.equal(opens,1);assert.equal(quote.approvalUrl,'http://localhost:4312/#approve=quote-open-test');assert.equal(quote.paymentExecuted,false);
  fail=true;await assert.rejects(client.quote(proposal));assert.equal(opens,1);
});
