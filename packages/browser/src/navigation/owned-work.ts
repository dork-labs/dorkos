import { parseBrowserCommand, type BrowserBinding, type BrowserCommand } from '../contracts.js';

/** Trusted host command authority, captured separately from untrusted navigation JSON. */
export interface OwnedNavigationAuthorization {
  isCurrent(): boolean;
  authorize(
    binding: BrowserBinding,
    url: string,
    signal: AbortSignal
  ): Promise<'allowed' | 'refused' | 'unknown'>;
}
declare const workBrand: unique symbol;
/** Engine-issued exact original navigation operation identity. */
export interface OwnedNavigationWork {
  readonly [workBrand]: never;
}
type Command = Extract<BrowserCommand, { kind: 'navigate' }>;
type Cell = {
  readonly command: string;
  readonly current: OwnedNavigationAuthorization['isCurrent'];
  readonly authorize: OwnedNavigationAuthorization['authorize'];
  owner?: object;
};
const cells = new WeakMap<object, Cell>();

/** Each constructor has its own issuer; command bodies cannot mint or select work. */
export function createOwnedNavigationIssuer() {
  const issued = new WeakSet<object>();
  return Object.freeze({
    issue(value: unknown, authorization: OwnedNavigationAuthorization): OwnedNavigationWork {
      const command = parseBrowserCommand(value);
      if (command.kind !== 'navigate') throw new Error('OWNED_NAVIGATION_COMMAND_REFUSED');
      const authorize = authorization.authorize.bind(authorization);
      const current = authorization.isCurrent.bind(authorization);
      if (!current()) throw new Error('OWNED_NAVIGATION_AUTHORITY_REFUSED');
      const token = Object.freeze(Object.create(null)) as OwnedNavigationWork;
      cells.set(token, { command: JSON.stringify(command), authorize, current });
      issued.add(token);
      return token;
    },
    invalidate(token: OwnedNavigationWork): void {
      if (issued.has(token)) cells.delete(token);
    },
  });
}

/** Consume exactly once, correlated to the actual parsed command and retained cohort. */
export function consumeOwnedNavigationWork(
  token: unknown,
  command: Command,
  owner: object
): token is OwnedNavigationWork {
  if (!token || typeof token !== 'object') return false;
  const cell = cells.get(token);
  if (!cell || cell.owner || cell.command !== JSON.stringify(command)) return false;
  cell.owner = owner;
  return true;
}

/** No callback can resurrect a settled, replaced or revoked original operation. */
export function ownedNavigationCurrent(token: OwnedNavigationWork, owner: object): boolean {
  const cell = cells.get(token);
  if (!cell || cell.owner !== owner) return false;
  try {
    return cell.current() && cells.get(token) === cell && cell.owner === owner;
  } catch {
    return false;
  }
}

/** Fresh URL permission is required around queue/reset/native boundaries, in addition to engine policy. */
export async function authorizeOwnedNavigation(
  token: OwnedNavigationWork,
  owner: object,
  binding: BrowserBinding,
  url: string,
  signal: AbortSignal
): Promise<'allowed' | 'refused' | 'unknown'> {
  const cell = cells.get(token);
  if (!cell || cell.owner !== owner || signal.aborted || !ownedNavigationCurrent(token, owner))
    return 'refused';
  try {
    const result = await cell.authorize(binding, url, signal);
    return !signal.aborted && ownedNavigationCurrent(token, owner) ? result : 'refused';
  } catch {
    return 'refused';
  }
}
