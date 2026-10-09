/** Shared extension admission and remount coordination. */
export interface ExtensionLoadAdmission {
  readonly suspended: boolean;
  readonly retirementFailed: boolean;
}
export interface ExtensionAuthOperation {
  readonly kind: 'signIn' | 'signUp' | 'signOut';
}
type Owner = object;
type Registration = {
  owner: Owner;
  admission: ExtensionLoadAdmission;
  retire: () => boolean;
  remount: () => Promise<void>;
};
let admission: ExtensionLoadAdmission = Object.freeze({
  suspended: false,
  retirementFailed: false,
});
let registration: Registration | null = null;
let occurrence: object = {};
const attempts = new WeakMap<
  ExtensionAuthOperation,
  {
    owner: Owner;
    occurrence: object;
    suspension: ExtensionLoadAdmission;
    state: 'pending' | 'authenticated' | 'resumed';
  }
>();
const listeners = new Set<() => void>();
const registeredOwners = new WeakSet<Owner>();
function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      failRetirement();
    }
  }
}
function failRetirement(): void {
  if (admission.retirementFailed) return;
  admission = Object.freeze({ suspended: true, retirementFailed: true });
  const old = registration;
  registration = null;
  try {
    old?.retire();
  } catch {
    /* Sticky uncertainty cannot be healed. */
  }
}
/** Exact snapshot identity is client load admission, never server approval. */
export function getExtensionLoadAdmission(): ExtensionLoadAdmission {
  return admission;
}
/** Subscribe without granting an extension owner or auth operation. */
export function subscribeExtensionLoadAdmission(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** Publish suspension before any cleanup/listener can reenter. */
export function suspendExtensionLoads(): void {
  occurrence = {};
  admission = Object.freeze({ suspended: true, retirementFailed: admission.retirementFailed });
  const old = registration;
  registration = null;
  try {
    if (old && !old.retire()) failRetirement();
  } catch {
    failRetirement();
  }
  // No outer continuation rewrites a newer nested admission or heals failure.
  notify();
}
/** Issue a genuine owner-bound attempt before its external auth operation. */
export function beginExtensionAuthOperation(
  owner: Owner,
  kind: ExtensionAuthOperation['kind']
): ExtensionAuthOperation {
  const token = Object.freeze({ kind });
  occurrence = {};
  admission = Object.freeze({ suspended: true, retirementFailed: admission.retirementFailed });
  // Install the attempt before any retirement/listener callback.
  attempts.set(token, { owner, occurrence, suspension: admission, state: 'pending' });
  const old = registration;
  registration = null;
  try {
    if (old && !old.retire()) failRetirement();
  } catch {
    failRetirement();
  }
  notify();
  return token;
}
/** Check the original occurrence, not a snapshot obtained after an await. */
export function isExtensionAuthOperationCurrent(
  owner: Owner,
  token: ExtensionAuthOperation
): boolean {
  const record = attempts.get(token);
  return !!record && record.owner === owner && record.occurrence === occurrence;
}
/** Trusted auth hook records the successful original response before login UI callbacks.
 * This does not resume admission or survive a newer sign-out/401 occurrence.
 */
export function authenticateExtensionAuthOperation(
  owner: Owner,
  token: ExtensionAuthOperation
): boolean {
  const record = attempts.get(token);
  if (
    !record ||
    record.state !== 'pending' ||
    token.kind === 'signOut' ||
    record.owner !== owner ||
    record.occurrence !== occurrence ||
    record.suspension !== admission
  )
    return false;
  record.state = 'authenticated';
  return true;
}
/** Resume only the current successful credential attempt after healthy retirement. */
export function resumeExtensionLoads(
  owner: Owner,
  token: ExtensionAuthOperation
): ExtensionLoadAdmission | null {
  const record = attempts.get(token);
  if (
    !record ||
    record.state !== 'authenticated' ||
    token.kind === 'signOut' ||
    !isExtensionAuthOperationCurrent(owner, token) ||
    attempts.get(token)?.suspension !== admission ||
    admission.retirementFailed
  )
    return null;
  occurrence = {};
  const resumed = Object.freeze({ suspended: false, retirementFailed: false });
  admission = resumed;
  attempts.set(token, { owner, occurrence, suspension: resumed, state: 'resumed' });
  notify();
  return admission === resumed && !resumed.retirementFailed ? resumed : null;
}
/** Exact provider registration; callbacks never overwrite a newer owner. */
export function registerExtensionLoadOwner(
  owner: Owner,
  snapshot: ExtensionLoadAdmission,
  retire: () => boolean,
  remount: () => Promise<void>
): () => void {
  if (admission !== snapshot || snapshot.suspended || snapshot.retirementFailed) return () => {};
  if (registration) {
    suspendExtensionLoads();
    failRetirement();
    notify();
    return () => {};
  }
  const record = { owner, admission: snapshot, retire, remount };
  registeredOwners.add(owner);
  registration = record;
  return () => {
    if (registration === record) registration = null;
  };
}
/** Existing remount compatibility is tied to the currently registered provider. */
export function registerExtensionRemount(handler: () => Promise<void>): () => void {
  // Legacy callers are provider-only; new provider uses registerExtensionLoadOwner.
  const owner = {};
  return registerExtensionLoadOwner(owner, admission, () => false, handler);
}
/** Request current-owner work; capture callback before the final identity guard. */
export function requestExtensionRemount(): Promise<void> {
  const current = registration;
  if (!current) return Promise.resolve();
  const fn = current.remount;
  if (
    registration !== current ||
    admission !== current.admission ||
    admission.suspended ||
    admission.retirementFailed
  )
    return Promise.resolve();
  return Reflect.apply(fn, undefined, []);
}

/** Preserve genuine provider cleanup failure even after its exact unregister. */
export function markExtensionRetirementFailed(owner: object): void {
  if (!registeredOwners.has(owner)) return;
  if (admission.retirementFailed) return;
  failRetirement();
  notify();
}

/** An unmounted pending auth producer cannot later resume this occurrence. */
export function cancelExtensionAuthOperation(owner: Owner, token: ExtensionAuthOperation): void {
  const record = attempts.get(token);
  if (record?.state !== 'pending' || !isExtensionAuthOperationCurrent(owner, token)) return;
  suspendExtensionLoads();
}
