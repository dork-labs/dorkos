/**
 * Whether this invocation asked for debug-level detail, in one place.
 *
 * Two commands in the `harness` namespace answer a failure the same way — one
 * sentence, the folder it happened in, and the way to the stack — and the rule
 * for "did you ask for the stack?" has to be the same rule in both, or the hint
 * one of them prints is a lie about the other.
 *
 * @module lib/debug-detail
 */
import { LOG_LEVEL_MAP } from '@dorkos/shared/config-schema';

/**
 * Whether this invocation asked for debug-level detail, by either spelling: the
 * `LOG_LEVEL` name a person exports, or the numeric `DORKOS_LOG_LEVEL` a parent
 * process (`cli.ts`, the server) has already resolved.
 *
 * @returns whether a stack trace was asked for.
 */
export function wantsDebugDetail(): boolean {
  /* eslint-disable no-restricted-syntax -- the harness branch in cli.ts runs before the log level is resolved and exported, so we mirror its `LOG_LEVEL || DORKOS_LOG_LEVEL` reading here */
  const named = LOG_LEVEL_MAP[process.env.LOG_LEVEL ?? ''];
  const numeric = Number(process.env.DORKOS_LOG_LEVEL);
  /* eslint-enable no-restricted-syntax */
  const level = named ?? (Number.isFinite(numeric) ? numeric : undefined);
  return level !== undefined && level >= LOG_LEVEL_MAP.debug;
}
