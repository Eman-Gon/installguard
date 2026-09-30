import { readFileSync } from 'node:fs';
const registry = JSON.parse(readFileSync(new URL('../profiles/registry.json', import.meta.url)));
export function profileFor(id) {
  const p = registry[id];
  if (!Object.hasOwn(registry, id) || p.status !== 'reviewed') throw new Error('Invalid or unreviewed test profile');
  if (!/^[\w.-]+\.mjs$/.test(p.testFile) || !p.artifacts.every(x => /^[\w-]+$/.test(x))) throw new Error('Invalid profile paths');
  if (!p.artifacts.includes(p.cacheFixture) || !/^[a-z0-9][a-z0-9/_.:-]+$/.test(p.image) || !/^22\.\d+\.\d+$/.test(p.target.version)) throw new Error('Invalid profile image/cache configuration');
  return p;
}
export function profiles() { return Object.keys(registry).filter(id => registry[id].status === 'reviewed').map(id => ({ id, ...profileFor(id) })); }
export function artifactProfile(ref) {
  const p = profiles().find(p => p.artifacts.includes(ref));
  if (!p) throw new Error('Only controlled artifacts in reviewed profiles are permitted');
  if (!p.artifacts.includes(p.cacheFixture) || !/^[a-z0-9][a-z0-9/_.:-]+$/.test(p.image) || !/^22\.\d+\.\d+$/.test(p.target.version)) throw new Error('Invalid profile image/cache configuration');
  return p;
}
