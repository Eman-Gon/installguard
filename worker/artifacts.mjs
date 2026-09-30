import { artifactProfile, profiles } from '../shared/profiles.mjs';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const fixturesRoot = fileURLToPath(new URL('../fixtures/', import.meta.url));
export const fixtureNames = profiles().flatMap(p => p.artifacts);
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export async function artifactIdentity(ref) {
  const profile = artifactProfile(ref);
  const directory = resolve(fixturesRoot, ref);
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Artifact directory symlinks are unsupported');
  const names = (await readdir(directory)).filter(n => !['node_modules'].includes(n)).sort();
  for (const name of names) { const st = await lstat(resolve(directory, name)); if (!st.isFile() || st.isSymbolicLink()) throw new Error('Only regular artifact files are permitted'); }
  const files = await Promise.all(names.map(async name => ({ path: name, sha256: sha256(await readFile(resolve(directory, name))) })));
  const lock = JSON.parse(await readFile(resolve(directory, 'package-lock.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  if (pkg.dependencies?.[profile.package.name] !== profile.package.version || lock.packages?.['node_modules/' + profile.package.name]?.version !== profile.package.version) throw new Error('Dependency/lock identity mismatch');
  return { ref, directory, digest: sha256(JSON.stringify(files)), lockfileDigest: sha256(await readFile(resolve(directory, 'package-lock.json'))), files };
}
