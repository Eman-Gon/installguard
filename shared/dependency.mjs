import { identity } from './identity.mjs';
export const DEPENDENCY_PROFILE = 'node-dependency-v1';
export const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export function validateDependency(r) {
  const c = r.context;
  if (!packageName.test(r.package?.name) || r.package.name.length > 214 || !exactVersion.test(r.package.version) || r.package.ecosystem !== 'npm') throw Error('Invalid exact npm package/version');
  if (!c || Object.keys(c).sort().join() !== 'moduleType,nodeMajor,projectId' || !/^[a-f0-9]{64}$/.test(c.projectId) || !['module','commonjs'].includes(c.moduleType) || c.nodeMajor !== 22) throw Error('Invalid minimal project context; only Node 22 is supported');
  if (r.target.os !== 'linux' || !['arm64','x64'].includes(r.target.arch) || r.target.runtime !== 'node' || r.target.version !== '22.11.0') throw Error('Target requires Linux Node 22.11.0');
  if (r.artifact.reference !== 'dependency-check' || r.artifact.digest !== identity(c) || !/^sha256:[a-f0-9]{64}$/.test(r.lockfileDigest)) throw Error('Context identity mismatch');
  return r;
}
