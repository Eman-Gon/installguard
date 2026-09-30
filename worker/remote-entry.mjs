import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRequest } from '../service/contract.mjs';
import { identity } from '../service/identity.mjs';
import { runWorker } from './run.mjs';

export const REMOTE_MARKER = 'INSTALLGUARD_REMOTE=';
export function validateEnvelope(input) {
  if (!input || !/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(input.executionId) || input.requestDigest !== identity(input.request)) throw new Error('Invalid remote execution identity');
}
export async function remoteEntry(action, input, { directory = resolve('.daytona/executions'), execute = runWorker } = {}) {
  validateEnvelope(input);
  const path = resolve(directory, input.executionId + '.json');
  const read = async () => {
    try {
      const record = JSON.parse(await readFile(path, 'utf8'));
      if (record.requestDigest !== input.requestDigest) throw new Error('Execution ID reused with different inputs');
      return record;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  if (action === 'read') return await read() || { executionId: input.executionId, requestDigest: input.requestDigest, state: 'unknown' };
  if (action !== 'run') throw new Error('Invalid remote action');
  await validateRequest(input.request);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const previous = await read();
  if (previous) return previous;
  const record = { executionId: input.executionId, requestDigest: input.requestDigest, state: 'running' };
  // Exclusive reservation survives crashes. Never re-execute an existing ID.
  try { await writeFile(path, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') return await read(); throw error; }
  const lockPath = resolve(directory, 'active.lock');
  let lock;
  const save = async () => { const temp = path + '.tmp'; await writeFile(temp, JSON.stringify(record), { mode: 0o600 }); await rename(temp, path); };
  try {
    lock = await open(lockPath, 'wx', 0o600);
    await lock.writeFile(input.executionId);
    record.result = await execute(input.request.artifact.reference, 'docker', input.request);
    record.state = 'completed';
    await save();
  } catch {
    record.state = 'unknown';
    record.error = 'Remote worker unavailable or interrupted; reconcile this execution ID without rerunning.';
    await save();
  } finally {
    if (lock) { await lock.close(); await unlink(lockPath); }
  }
  return record;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const encoded = process.argv[3] || '';
    if (!/^[A-Za-z0-9+/=]{1,24000}$/.test(encoded)) throw new Error('Invalid remote payload');
    const record = await remoteEntry(process.argv[2], JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')));
    console.log(REMOTE_MARKER + JSON.stringify(record));
  } catch { console.error('Remote runner rejected the request or could not read its durable record.'); process.exitCode = 1; }
}
