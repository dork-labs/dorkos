import type { Cleanup } from '../index.mjs';

/** Separate native admission evidence carried by the private POSIX adapter. */
export type PosixJoin = Exclude<Cleanup, { kind: 'never-acquired' }> & {
  readonly target?: 'never-authorized';
};
export function classifyPosixJoin(fact: unknown, sawNative: boolean): PosixJoin;
