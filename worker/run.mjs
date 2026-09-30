import { artifactProfile } from '../shared/profiles.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { artifactIdentity, sha256 } from './artifacts.mjs';
export function command(bin, args, options = {}) {
  return new Promise(resolve => {
    let logs = '', timedOut = false, outputLimited = false;
    const child = spawn(bin, args, { ...options, env: options.env || { PATH: process.env.PATH, HOME: tmpdir(), LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = chunk => { if (logs.length < 131072) logs += chunk.toString().slice(0, 131072 - logs.length); else outputLimited = true; };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 90000);
    child.on('error', error => { clearTimeout(timer); resolve({ exitCode: null, logs: String(error), timedOut: false, outputLimited }); });
    child.on('close', (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal, logs, timedOut, outputLimited }); });
  });
}
export async function runWorker(ref, mode = 'docker', expected = null) {
  if (!['docker', 'local-development'].includes(mode)) throw new Error('Invalid worker mode');
  const profile = artifactProfile(ref);
  const identity = await artifactIdentity(ref);
  if (expected && (expected.artifact.digest !== 'sha256:' + identity.digest || expected.lockfileDigest !== 'sha256:' + identity.lockfileDigest)) throw new Error('Artifact changed after request validation');
  const work = await mkdtemp(join(tmpdir(), 'installguard-worker-'));
  const startedAt = new Date().toISOString();
  let install, test, environment;
  try {
    await cp(identity.directory, work, { recursive: true, filter: path => !path.includes('node_modules') });
    // Snapshot check binds what is executed to the previously identified fixture.
    const after = await artifactIdentity(ref);
    if (after.digest !== identity.digest) throw new Error('Artifact changed while preparing execution');
    for (const file of identity.files) {
      if (sha256(await readFile(join(work, file.path))) !== file.sha256) throw new Error('Snapshot artifact digest mismatch');
    }
    if (mode === 'local-development') {
      environment = { os: process.platform, architecture: process.arch, runtime: `node-${process.versions.node}`, isolated: false, mode };
      install = await command('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(tmpdir(), 'installguard-npm-cache')], { cwd: work });
      if (install.exitCode === 0) test = await command(process.execPath, ['--test', profile.testFile], { cwd: work });
    } else {
      await chmod(work, 0o755);
      const containerName = `installguard-${randomUUID()}`;
      const image = process.env.INSTALLGUARD_WORKER_IMAGE || profile.image;
      const inspected = await command('docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
      const imageId = inspected.logs.trim();
      if (inspected.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(imageId)) return { outcome: 'inconclusive', exitCode: null, logs: inspected.logs, limitations: ['Pinned worker image unavailable; isolated execution was not performed.'] };
      const result = await command('docker', ['run', '--rm', '--name', containerName, '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=256m', '--cpus=1', '--user=1000:1000', '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m,mode=1777', '--mount', `type=bind,src=${work},dst=/input,readonly`, imageId, 'node', '/opt/container-entry.mjs', profile.testFile]);
      if (result.timedOut) await command('docker', ['rm', '-f', containerName]);
      const marker = result.logs.lastIndexOf('INSTALLGUARD_RESULT=');
      if (marker >= 0) {
        try { ({ install, test, environment } = JSON.parse(result.logs.slice(marker + 20).trim())); } catch { /* invalid evidence is inconclusive */ }
      }
      if (environment) environment.imageDigest = imageId;
      if (!environment) { environment = { os: 'unknown', architecture: 'unknown', runtime: 'unknown', isolated: false, mode }; install = result; }
    }
    const outcome = !test || test.timedOut || test.exitCode === null ? 'inconclusive' : test.exitCode === 0 ? 'passed' : 'failed';
    return { startedAt, finishedAt: new Date().toISOString(), artifactDigest: identity.digest, lockfileDigest: identity.lockfileDigest, environment, install, test: test || null, outcome, exitCode: test?.exitCode ?? install?.exitCode ?? null, logs: [install?.logs, test?.logs].filter(Boolean).join('\n'), limitations: mode === 'local-development' ? ['Local development execution is not isolated and does not verify the requested Linux environment.'] : ['Controlled fixtures only; ordinary containers are not a complete hostile-code sandbox.'] };
  } finally { await rm(work, { recursive: true, force: true }); }
}
