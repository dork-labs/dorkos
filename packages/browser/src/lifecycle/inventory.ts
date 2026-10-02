import type { ProcessIdentity } from '../configuration.js';
import { BrowserLifecycleError } from './errors.js';

/** Validate a complete observation; malformed/duplicate identities never establish absence. */
export function completeInventory(
  value: unknown,
  root: ProcessIdentity
): readonly ProcessIdentity[] {
  if (!value || typeof value !== 'object')
    throw new BrowserLifecycleError('PROCESS_OBSERVATION_UNAVAILABLE');
  const result = value as { status?: unknown; identities?: unknown };
  if (
    result.status !== 'complete' ||
    !Array.isArray(result.identities) ||
    result.identities.length < 1 ||
    result.identities.length > 512
  )
    throw new BrowserLifecycleError('PROCESS_OBSERVATION_UNAVAILABLE');
  const pids = new Set<number>();
  const identities = result.identities.map((item: unknown) => {
    if (!item || typeof item !== 'object')
      throw new BrowserLifecycleError('PROCESS_OBSERVATION_UNAVAILABLE');
    const id = item as { pid?: unknown; birth?: unknown };
    if (
      typeof id.pid !== 'number' ||
      !Number.isSafeInteger(id.pid) ||
      id.pid < 1 ||
      pids.has(id.pid) ||
      typeof id.birth !== 'string' ||
      id.birth.length < 1 ||
      id.birth.length > 128 ||
      id.birth.trim() !== id.birth ||
      [...id.birth].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      throw new BrowserLifecycleError('PROCESS_OBSERVATION_UNAVAILABLE');
    pids.add(id.pid);
    return Object.freeze({ pid: id.pid, birth: id.birth });
  });
  if (!identities.some((id) => id.pid === root.pid && id.birth === root.birth))
    throw new BrowserLifecycleError('PROCESS_ATTRIBUTION_UNAVAILABLE');
  return Object.freeze(identities);
}
