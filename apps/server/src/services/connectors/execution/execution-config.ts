/** Secret-free material generation for execution-affecting provider configuration. */
import { createHash } from 'node:crypto';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`;
}

/**
 * Hash provider construction material without retaining credentials or config.
 *
 * @param material - Exact server-owned values that affect provider execution.
 * @returns A one-way SHA-256 digest safe to persist but never expose publicly.
 */
export function connectorExecutionConfigDigest(material: unknown): string {
  return createHash('sha256').update(canonical(material)).digest('hex');
}
