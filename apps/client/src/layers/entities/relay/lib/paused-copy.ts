/**
 * The words for a connection paused until its owner confirms the
 * `env:`/`keychain:` settings it sends (DOR-3271; designer spec
 * `adapter-confirm`). Pure, so every rule is a table test.
 *
 * The host arrives from the server already in ASCII: a Unicode look-alike is
 * its `xn--` form here and everywhere else it shows. A setting's value never
 * reaches the client, only its name.
 *
 * @module entities/relay/lib/paused-copy
 */
import type { AdapterConfirmation } from '@dorkos/shared/relay-schemas';

/** A reference's name without its scheme: `env:DEPLOY_TOKEN` → `DEPLOY_TOKEN`. */
function nameOf(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

/** "A", "A and B", or "3 settings": what a connection sends, by name. */
function whatItSends(confirmation: AdapterConfirmation, withScheme: boolean): string {
  const names = confirmation.references.map((r) => (withScheme ? r.ref : nameOf(r.ref)));
  if (names.length <= 2) return names.join(' and ');
  return `${names.length} settings`;
}

/** " to host", or nothing when the connection names no address. */
function toHost(confirmation: AdapterConfirmation): string {
  return confirmation.host ? ` to ${confirmation.host}` : '';
}

/**
 * The quiet meta line: `Webhook · sends env:DEPLOY_TOKEN to hooks.example.dev`.
 *
 * @param kind - The connection's kind ("Webhook", "Telegram").
 * @param confirmation - What the server listed it with.
 */
export function pausedMeta(kind: string, confirmation: AdapterConfirmation): string {
  return `${kind} · sends ${whatItSends(confirmation, true)}${toHost(confirmation)}`;
}

/**
 * Every reference by name, for the hover and focus list when there are 3+.
 *
 * @param confirmation - What the server listed it with.
 */
export function pausedReferenceList(confirmation: AdapterConfirmation): string {
  return confirmation.references.map((r) => r.ref).join(', ');
}

/**
 * The button's quiet line: what Confirm lets it do, and the way out.
 *
 * @param confirmation - What the server listed it with.
 */
export function pausedConfirmHint(confirmation: AdapterConfirmation): string {
  const what = whatItSends(confirmation, false);
  return `Lets it send ${what}${toHost(confirmation)} again. Not yours? Remove it below.`;
}

/**
 * The paused line, singular or plural by how many settings it sends.
 *
 * @param confirmation - What the server listed it with.
 */
export function pausedMessage(confirmation: AdapterConfirmation): string {
  return confirmation.references.length > 1
    ? 'Paused · confirm the settings it sends.'
    : 'Paused · confirm the setting it sends.';
}

/**
 * The Confirm button's label, singular or plural by how many settings it sends.
 *
 * @param confirmation - What the server listed it with.
 */
export function pausedConfirmLabel(confirmation: AdapterConfirmation): string {
  return confirmation.references.length > 1 ? 'Confirm these settings' : 'Confirm this setting';
}

/**
 * The Needs you row's notice: what Confirm does, led by what it dropped meanwhile.
 *
 * @param notSent - Messages dropped while paused.
 */
export function pausedRowNotice(notSent: number): string {
  if (notSent <= 0) return 'Confirm what it sends to start it again.';
  const count = notSent > 99 ? '99+ messages' : notSent === 1 ? '1 message' : `${notSent} messages`;
  return `${count} not sent. Confirm what it sends.`;
}

/**
 * The dropped-message line, or nothing before anything was dropped:
 * "1 message", "3 messages", capped at "99+ messages".
 *
 * @param notSent - Messages dropped while paused.
 */
export function pausedNotSent(notSent: number): string | undefined {
  if (notSent <= 0) return undefined;
  if (notSent === 1) return '1 message not sent while paused';
  return `${notSent > 99 ? '99+' : notSent} messages not sent while paused`;
}

/**
 * The Needs you row's meta line: `Webhook · env:DEPLOY_TOKEN → hooks.example.dev`.
 *
 * @param kind - The connection's kind ("Webhook", "Telegram").
 * @param confirmation - What the server listed it with.
 */
export function pausedRowMeta(kind: string, confirmation: AdapterConfirmation): string {
  const host = confirmation.host ? ` → ${confirmation.host}` : '';
  return `${kind} · ${whatItSends(confirmation, true)}${host}`;
}

/**
 * The Needs you row's quiet line: what Confirm lets it do, and that nothing
 * else changes. The row has nothing to open, so no "remove it" here.
 *
 * @param confirmation - What the server listed it with.
 */
export function pausedRowHint(confirmation: AdapterConfirmation): string {
  return `Lets it send ${whatItSends(confirmation, false)}${toHost(confirmation)} again. Nothing else changes.`;
}
