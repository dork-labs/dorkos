import type { OriginalQuickTunnelReply } from './quick-tunnel-preflight.fixture.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const originalUpdateRedirectError =
  'The script resource is behind a redirect, which is disallowed.';
const owners = new WeakSet<object>();

/** Issue only exact owned-route script replies, armed after the original registration succeeds. */
export function createOriginalUpdateRedirect(current: () => void) {
  const entries = new Map<string, { allowed: string; denied: string; armed: boolean }>();
  const owner = Object.freeze({
    reply(
      role: 'allowed' | 'denied',
      path: string,
      origins: readonly string[]
    ): OriginalQuickTunnelReply | undefined {
      current();
      const found = /^\/update-redirect\/([a-f0-9-]{36})\.js$/.exec(path);
      if (role !== 'allowed' || !found) return;
      const nonce = found[1]!;
      if (!uuid.test(nonce) || origins.length !== 2 || origins[0] === origins[1])
        throw new Error('UPDATE_REDIRECT_OWNED_ORIGINS_REQUIRED');
      for (const origin of origins) {
        const parsed = new URL(origin);
        if (
          parsed.protocol !== 'https:' ||
          parsed.origin !== origin ||
          parsed.username ||
          parsed.password
        )
          throw new Error('UPDATE_REDIRECT_OWNED_ORIGINS_REQUIRED');
      }
      let entry = entries.get(nonce);
      if (!entry) {
        if (entries.size >= 32) throw new Error('UPDATE_REDIRECT_OWNER_BOUND');
        entry = { allowed: origins[0]!, denied: origins[1]!, armed: false };
        entries.set(nonce, entry);
      }
      if (entry.allowed !== origins[0] || entry.denied !== origins[1])
        throw new Error('UPDATE_REDIRECT_ORIGIN_CHANGED');
      return entry.armed
        ? Object.freeze({
            status: 302,
            contentType: 'application/javascript',
            body: '',
            location: entry.denied + '/forbidden/' + nonce + '/update-script',
          })
        : Object.freeze({
            status: 200,
            contentType: 'application/javascript',
            body: "self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));",
          });
    },
    arm(nonce: string, allowed: string, denied: string) {
      current();
      const entry = entries.get(nonce);
      if (!entry || entry.armed || entry.allowed !== allowed || entry.denied !== denied)
        throw new Error('UPDATE_REDIRECT_ORIGINAL_REGISTRATION_REQUIRED');
      entry.armed = true;
    },
  });
  owners.add(owner);
  return owner;
}

/** Refuse copied constructor-shaped issuers before reading any member. */
export function readOriginalUpdateRedirect(
  value: unknown
): ReturnType<typeof createOriginalUpdateRedirect> {
  if (!value || typeof value !== 'object' || !owners.has(value))
    throw new Error('UPDATE_REDIRECT_ORIGINAL_OWNER_REQUIRED');
  return value as ReturnType<typeof createOriginalUpdateRedirect>;
}

/** Ordinary browser registration.update; only its precise native redirect refusal qualifies. */
export async function runOriginalUpdateRedirect(script: string) {
  const registrations = await navigator.serviceWorker.getRegistrations();
  const matching = registrations.filter((row) => row.active?.scriptURL === script);
  if (matching.length !== 1)
    throw new Error('UPDATE_REDIRECT_ORIGINAL_ACTIVE_REGISTRATION_REQUIRED');
  try {
    await matching[0]!.update();
    throw new Error('UPDATE_REDIRECT_UNEXPECTED_SUCCESS');
  } catch (value) {
    if (
      !(value instanceof TypeError) ||
      !value.message.endsWith('The script resource is behind a redirect, which is disallowed.')
    )
      throw value;
    return {
      name: value.name,
      redirectError: 'The script resource is behind a redirect, which is disallowed.',
    };
  }
}

/** Validate the fixed projection together with the independent actual 302 response and zero-network oracles. */
export function readOriginalUpdateRedirectResult(value: unknown) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 2 ||
    !('name' in value) ||
    value.name !== 'TypeError' ||
    !('redirectError' in value) ||
    value.redirectError !== originalUpdateRedirectError
  )
    throw new Error('UPDATE_REDIRECT_NATIVE_ERROR_REQUIRED');
  return Object.freeze({ name: 'TypeError', redirectError: originalUpdateRedirectError });
}
