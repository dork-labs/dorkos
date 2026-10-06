import { parseBrowserCommand, type BrowserBinding, type BrowserCommand } from '../contracts.js';
import type { NativeInputStep } from './types.js';

/** Private per-dispatch checks captured from the authenticated server, never command JSON. */
export interface OwnedInputAuthorization {
  /** Recheck actor/grant/epoch before and after each unstarted atomic operation. */
  authorize(
    binding: BrowserBinding,
    step: NativeInputStep,
    signal: AbortSignal
  ): Promise<'allowed' | 'refused' | 'unknown'>;
  /** Synchronous last admission fence, including after fallible native-method lookup. */
  isCurrent(): boolean;
}
declare const ownedWorkBrand: unique symbol;
/** Engine-issued opaque original work identity; possessing its shape grants nothing. */
export interface OwnedInputWork {
  readonly [ownedWorkBrand]: never;
}

type InputCommand = Extract<BrowserCommand, { kind: 'input' }>;
type Cell = {
  readonly command: string;
  readonly authorize: OwnedInputAuthorization['authorize'];
  readonly current: OwnedInputAuthorization['isCurrent'];
  owner?: object;
};
const cells = new WeakMap<object, Cell>();

/** Constructor-private issuer; tokens stay inside original submission and queue closures. */
export function createOwnedInputIssuer() {
  const issued = new WeakSet<object>();
  return Object.freeze({
    issue(value: unknown, authorization: OwnedInputAuthorization): OwnedInputWork {
      const command = parseBrowserCommand(value);
      if (command.kind !== 'input') throw new Error('OWNED_INPUT_COMMAND_REFUSED');
      const authorize = authorization.authorize.bind(authorization),
        current = authorization.isCurrent.bind(authorization);
      const token = Object.freeze(Object.create(null)) as OwnedInputWork;
      cells.set(token, { command: JSON.stringify(command), authorize, current });
      issued.add(token);
      return token;
    },
    invalidate(token: OwnedInputWork): void {
      if (issued.has(token)) cells.delete(token);
    },
  });
}

/** Consume once for the exact engine-parsed command and original queue Work object. */
export function consumeOwnedInputWork(
  token: unknown,
  command: InputCommand,
  owner: object
): token is OwnedInputWork {
  if (!token || typeof token !== 'object') return false;
  const cell = cells.get(token);
  if (!cell || cell.owner || cell.command !== JSON.stringify(command)) return false;
  cell.owner = owner;
  return true;
}

/** Refuse forged/replayed/settled identities and synchronous revocation, never infer cancellation. */
export function ownedInputWorkCurrent(token: OwnedInputWork, owner: object): boolean {
  const cell = cells.get(token);
  if (!cell || cell.owner !== owner) return false;
  try {
    return cell.current() && cells.get(token) === cell && cell.owner === owner;
  } catch {
    return false;
  }
}

/** Actual atomic policy callback is tied to the retained original Work, not ambient binding state. */
export async function authorizeOwnedInputWork(
  token: OwnedInputWork,
  owner: object,
  binding: BrowserBinding,
  step: NativeInputStep,
  signal: AbortSignal
): Promise<'allowed' | 'refused' | 'unknown'> {
  const cell = cells.get(token);
  if (!cell || cell.owner !== owner || !ownedInputWorkCurrent(token, owner)) return 'refused';
  try {
    const result = await cell.authorize(binding, step, signal);
    return !signal.aborted && ownedInputWorkCurrent(token, owner) ? result : 'refused';
  } catch {
    return 'refused';
  }
}

/** Settlement invalidates admission while preserving the queue's independent native cleanup custody. */
export function settleOwnedInputWork(token: OwnedInputWork, owner: object): void {
  if (cells.get(token)?.owner === owner) cells.delete(token);
}
