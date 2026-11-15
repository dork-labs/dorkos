/**
 * Run a room scenario with DOR-3858's boot flag set for its duration, for tests that pin both
 * sides of `DORKOS_MARK_STRANGER_TURNS`. `env` is parsed once at import, so the flag is swapped on
 * the parsed object and put back afterwards.
 *
 * @module services/rooms/__tests__/stranger-mark-flag
 */
import { env } from '../../../env.js';

/**
 * Run `run` with `DORKOS_MARK_STRANGER_TURNS` set to `enabled`, then restore it.
 *
 * @param enabled - The flag's value while `run` runs.
 * @param run - The scenario.
 */
export async function withStrangerMarkFlag<T>(enabled: boolean, run: () => Promise<T>): Promise<T> {
  const key = 'DORKOS_MARK_STRANGER_TURNS';
  const target = env as unknown as Record<string, unknown>;
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, enumerable: true, value: enabled });
  try {
    return await run();
  } finally {
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  }
}
