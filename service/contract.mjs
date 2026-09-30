import { DEPENDENCY_PROFILE, validateDependency } from '../shared/dependency.mjs';
import { profileFor } from '../shared/profiles.mjs';
import { artifactIdentity } from '../worker/artifacts.mjs';
function exactKeys(obj, keys) { return obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).sort().join() === [...keys].sort().join(); }
export async function validateRequest(r) {
  if (!exactKeys(r, ['requestId','package','lockfileDigest','artifact','target','goal','testProfile',...(r?.testProfile===DEPENDENCY_PROFILE?['context']:[])]) || typeof r.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(r.requestId)) throw new Error('Invalid request shape or ID');
  if(r.testProfile===DEPENDENCY_PROFILE) return validateDependency(r);
  const profile = profileFor(r.testProfile);
  if (!exactKeys(r.package, ['ecosystem','name','version']) || Object.entries(profile.package).some(([k,v]) => r.package[k] !== v)) throw new Error('Controlled profile requires its reviewed package/version');
  if (!exactKeys(r.target, ['os','arch','runtime','version']) || !profile.target.architectures.includes(r.target.arch) || ['os','runtime','version'].some(k => r.target[k] !== profile.target[k])) throw new Error('Target must match the reviewed profile');
  if (typeof r.goal !== 'string' || !r.goal.trim() || r.goal.length > 4000 || !exactKeys(r.artifact, ['digest','reference'])) throw new Error('Invalid goal or artifact');
  if (!profile.artifacts.includes(r.artifact.reference)) throw new Error('Only controlled artifacts in this profile are permitted');
  const artifact = await artifactIdentity(r.artifact.reference);
  if (r.artifact.digest !== 'sha256:' + artifact.digest || r.lockfileDigest !== 'sha256:' + artifact.lockfileDigest) throw new Error('Artifact or lockfile digest mismatch');
  return r;
}
