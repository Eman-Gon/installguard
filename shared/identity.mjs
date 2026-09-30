import { createHash } from 'node:crypto';
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => JSON.stringify(key) + ':' + canonical(val)).join(',') + '}';
  return JSON.stringify(value);
}
export const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
export const identity = value => hash(canonical(value));
export const digest = value => identity(value).slice(7);
