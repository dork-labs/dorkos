import { parseBrowserCommand, type BrowserBinding, type BrowserCommand } from '../contracts.js';

/** Captured original viewer permission, never a wire grant or ambient binding allowance. */
export interface OwnedCaptureAuthorization {
  isCurrent(): boolean;
  authorize(
    binding: BrowserBinding,
    signal: AbortSignal
  ): Promise<'allowed' | 'refused' | 'unknown'>;
}
declare const captureWorkBrand: unique symbol;
export interface OwnedCaptureWork {
  readonly [captureWorkBrand]: never;
}
type Command = Extract<BrowserCommand, { kind: 'capture' }>;
type Cell = {
  command: string;
  current: OwnedCaptureAuthorization['isCurrent'];
  authorize: OwnedCaptureAuthorization['authorize'];
  owner?: object;
  revoked?: boolean;
};
const cells = new WeakMap<object, Cell>();
const cancellations = new WeakSet<object>();

/** Read-only private outcome provenance, never a permission or structural error-code check. */
export function isOwnedCaptureCancellation(error: unknown): boolean {
  return !!error && typeof error === 'object' && cancellations.has(error);
}

/** Mark only an error from this consumed original permission's successful false return. */
export function markOwnedCaptureCancellation(
  token: OwnedCaptureWork,
  owner: object,
  error: object
) {
  const cell = cells.get(token);
  if (cell?.owner === owner && cell.revoked === true) cancellations.add(error);
}

/** Exact constructor owns issuance and settlement, independent of ordinary engine.capture. */
export function createOwnedCaptureIssuer() {
  const originals = new WeakSet<object>();
  return Object.freeze({
    issue(value: unknown, authorization: OwnedCaptureAuthorization): OwnedCaptureWork {
      const command = parseBrowserCommand(value);
      if (command.kind !== 'capture') throw new Error('OWNED_CAPTURE_COMMAND_REFUSED');
      const current = authorization.isCurrent.bind(authorization),
        authorize = authorization.authorize.bind(authorization);
      const token = Object.freeze(Object.create(null)) as OwnedCaptureWork;
      cells.set(token, { command: JSON.stringify(command), current, authorize });
      originals.add(token);
      return token;
    },
    invalidate(token: OwnedCaptureWork) {
      if (originals.has(token)) cells.delete(token);
    },
  });
}
/** Bind an issued token to one original capture dispatcher owner exactly once. */
export function consumeOwnedCaptureWork(
  token: unknown,
  command: Command,
  owner: object
): token is OwnedCaptureWork {
  if (!token || typeof token !== 'object') return false;
  const cell = cells.get(token);
  if (!cell || cell.owner || cell.command !== JSON.stringify(command)) return false;
  cell.owner = owner;
  return true;
}
/** Recheck the captured permission and exact token owner without admitting new work. */
export function ownedCaptureWorkCurrent(token: OwnedCaptureWork, owner: object): boolean {
  const cell = cells.get(token);
  if (!cell || cell.owner !== owner) return false;
  try {
    const current = cell.current();
    cell.revoked = current === false && cells.get(token) === cell && cell.owner === owner;
    return current && cells.get(token) === cell && cell.owner === owner;
  } catch {
    cell.revoked = false;
    return false;
  }
}
/** Refresh the original permission and retain the owner check through its settlement. */
export async function authorizeOwnedCaptureWork(
  token: OwnedCaptureWork,
  owner: object,
  binding: BrowserBinding,
  signal: AbortSignal
) {
  const cell = cells.get(token);
  if (!cell || cell.owner !== owner || !ownedCaptureWorkCurrent(token, owner))
    return 'refused' as const;
  try {
    const result = await cell.authorize(binding, signal);
    return !signal.aborted && ownedCaptureWorkCurrent(token, owner) ? result : 'refused';
  } catch {
    return 'refused' as const;
  }
}
/** Release only the token consumed by this original capture owner. */
export function settleOwnedCaptureWork(token: OwnedCaptureWork, owner: object) {
  if (cells.get(token)?.owner === owner) cells.delete(token);
}
