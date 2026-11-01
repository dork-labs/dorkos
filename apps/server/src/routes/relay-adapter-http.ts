/**
 * The HTTP edges the adapter routes share: how an adapter refusal is answered,
 * and who the secret rules treat as having written a config (DOR-3271).
 *
 * Split from {@link module:routes/relay-adapters} to keep that file under its
 * line ceiling.
 *
 * @module routes/relay-adapter-http
 */
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readJsonBody } from '../http/request-body.js';
import { errorRefusalUnlessOwner } from './cloud-owner-bar.js';
import { holdForStepUp } from './step-up-guard.js';
import {
  presentsProgramCredential,
  refuseUnlessAccountOwner,
  requirePersonAtThisComputer,
} from '../lib/caller-authority.js';
import { errorBody } from '../lib/route-utils.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
import { AdapterError, type AdapterManager } from '../services/relay/adapter-manager.js';
import type { SecretWriter } from '../services/relay/adapter-secret-policy.js';

/** Map adapter error codes to HTTP status codes. */
const ADAPTER_ERROR_STATUS: Record<string, number> = {
  DUPLICATE_ID: 409,
  UNKNOWN_TYPE: 400,
  MULTI_INSTANCE_DENIED: 400,
  NOT_FOUND: 404,
  REMOVE_BUILTIN_DENIED: 400,
  // A config its schema refuses — a webhook aimed at a DorkOS address among
  // them (DOR-2432). The caller's mistake, so a 400 that says which rule.
  INVALID_CONFIG: 400,
  // What the owner confirmed no longer matches the connection (DOR-3271).
  CONFIRMATION_STALE: 409,
};

/**
 * Answer an AdapterError, mapping its code to an HTTP status via ADAPTER_ERROR_STATUS.
 *
 * @param c - The Hono context
 * @param err - The AdapterError to answer
 */
export function sendAdapterError(c: Context<ApiEnv>, err: AdapterError): Response {
  const status = (ADAPTER_ERROR_STATUS[err.code] ?? 500) as ContentfulStatusCode;
  return c.json({ error: err.message, code: err.code }, status);
}

/**
 * Who is writing an adapter's settings, for the secret rules (DOR-3271): a
 * person only when the caller is the owner of this install
 * (`refuseUnlessAccountOwner`, the bar the account and provider-key routes
 * use). An `env:` or `keychain:` reference reads the owner's own machine, so a
 * signed-in person who does not own it writes as anyone else does.
 */
export function secretWriter(c: Context<ApiEnv>): SecretWriter {
  return refuseUnlessAccountOwner(honoRequestFacts(c)) === undefined ? 'person' : 'agent';
}

/** What the owner was shown for one connection: its name, and what it sends where. */
interface PausedView {
  name: string;
  /** The connection type's own name, shown beside a label someone chose. */
  typeName?: string;
  references: readonly { ref: string }[];
  host?: string;
}

/** A connection as the catalog lists it, or `undefined` when there is none by that id. */
function pausedView(adapterManager: AdapterManager, id: string): PausedView | undefined {
  for (const entry of adapterManager.getCatalog()) {
    const instance = entry.instances.find((candidate) => candidate.id === id);
    if (!instance) continue;
    return {
      name: instance.label || entry.manifest.displayName,
      typeName: entry.manifest.displayName,
      references: instance.confirmation?.references ?? [],
      ...(instance.confirmation?.host ? { host: instance.confirmation.host } : {}),
    };
  }
  return undefined;
}

/** A setting's name without its scheme: `env:DEPLOY_TOKEN` → `DEPLOY_TOKEN`. */
export function settingName(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

/**
 * Every setting named, never a count, so the sheet shows exactly what it
 * approves (Security, #3401 Should 1): "A", "A and B", "A, B and C".
 *
 * @param names - The settings' names.
 */
export function settingNamesText(names: readonly string[]): string {
  if (names.length === 0) return 'its settings';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The longest connection name the sheet shows before cutting it. */
const MAX_SHOWN_NAME = 40;

/**
 * A connection's name as the sheet shows it: quoted and cut short, since an
 * agent may have chosen it (Security, #3401 Should 2).
 *
 * @param name - The connection's label or type name.
 */
export function quotedName(name: string): string {
  const flat = name.replace(/\s+/g, ' ').trim();
  const cut = flat.length > MAX_SHOWN_NAME ? `${flat.slice(0, MAX_SHOWN_NAME - 1)}…` : flat;
  return `“${cut}”`;
}

/**
 * The step-up sheet's line, built here from what the server holds, never from
 * the request: "Lets “Deploy hooks” send DEPLOY_TOKEN to hooks.example.dev
 * again." The host is the catalog's, always ASCII.
 */
export function confirmReason(shown: PausedView): string {
  const what = settingNamesText(shown.references.map((r) => settingName(r.ref)));
  const where = shown.host ? ` to ${shown.host}` : '';
  const type = shown.typeName && shown.typeName !== shown.name ? ` (${shown.typeName})` : '';
  return `Lets ${quotedName(shown.name)}${type} send ${what}${where} again.`;
}

/**
 * An adapter call's answer, as a held action's commit gives it: its own status
 * and body, or the refusal an {@link AdapterError} maps to.
 *
 * @param run - The adapter call.
 * @param failed - What to say when it throws something else.
 */
export async function adapterResult(
  run: () => Promise<{ status: number; body: unknown }>,
  failed: string
): Promise<{ status: number; body: unknown }> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AdapterError) {
      return {
        status: ADAPTER_ERROR_STATUS[err.code] ?? 500,
        body: { error: err.message, code: err.code },
      };
    }
    return { status: 500, body: { error: err instanceof Error ? err.message : failed } };
  }
}

/**
 * With no owner yet there is no password to ask for, and the person at this
 * computer is the person (DOR-3330, Security on DOR-3467). So an action runs
 * with no sheet, but only for a person at this computer: an agent, an
 * approval token or any credential header is refused. The residual is
 * DOR-505's: a program here that sends none of them reads as the person until
 * an owner exists.
 *
 * @param c - The request.
 * @param personOnly - The refusal's sentence.
 * @returns The 403, or `undefined` when the person at this computer may go on.
 */
export function noOwnerRefusal(c: Context<ApiEnv>, personOnly: string): Response | undefined {
  const facts = honoRequestFacts(c);
  if (presentsProgramCredential(facts) || requirePersonAtThisComputer(facts) !== undefined) {
    return c.json(errorBody(personOnly, 'person_only'), 403);
  }
  return undefined;
}

/** How the confirm routes word a refusal: to anything but a person, and to a non-owner. */
const CONFIRM_WORDING = {
  personOnly: 'Only a person can confirm this setting.',
  action: 'confirm this setting',
};

/**
 * `POST /adapters/:id/confirm-references` with `{ fingerprint }`: the owner
 * confirms a connection paused for `env:`/`keychain:` references nobody
 * recorded a person saving (DOR-3271). It approves exactly the summary the
 * owner was shown, so a connection that changed since answers 409. It runs
 * only after "Confirm it's you" (DOR-3234): the route holds it and answers
 * `428`, and the step-up runs it once the owner's password passes.
 * `DELETE` on the same path is the toast's Undo: it takes the approval back
 * and pauses the connection again, and asks for nothing, since it only narrows. Both write the record that decides what a
 * connection may send, so both admit only the owner of this install
 * (`person_only` for an agent, `owner_only` for a signed-in person who does not
 * own it); anything else gets a 403.
 *
 * @param router - The adapter routes' router.
 * @param adapterManager - The adapter manager.
 * @param ownerExists - Whether this install has an owner yet; the owner account by default.
 */
export function registerConfirmReferencesRoute(
  router: Hono<ApiEnv>,
  adapterManager: AdapterManager,
  ownerExists: () => boolean = () => readOwnerAccount() !== null
): void {
  /** Run the confirm (or its Undo), as the answer the route gives. */
  const run = (id: string, fingerprint: string | null, undo: boolean) =>
    adapterResult(async () => {
      await adapterManager.confirmReferences(id, fingerprint, undo);
      return { status: 200, body: { ok: true } };
    }, 'Confirm failed');
  const handle = async (c: Context<ApiEnv>, undo: boolean) => {
    const refusal = errorRefusalUnlessOwner(honoRequestFacts(c), CONFIRM_WORDING);
    if (refusal) return c.json(refusal, 403);
    const id = c.req.param('id') ?? '';
    if (undo) {
      // Undo only narrows (it pauses the connection again), so it asks for nothing.
      const { status, body } = await run(id, null, true);
      return c.json(body, status as ContentfulStatusCode);
    }
    const body = readJsonBody(c) as { fingerprint?: unknown } | undefined;
    if (typeof body?.fingerprint !== 'string') {
      return c.json({ error: 'Missing what you confirmed.', code: 'INVALID_CONFIG' }, 400);
    }
    const fingerprint = body.fingerprint;
    const shown = pausedView(adapterManager, id);
    if (!shown)
      return sendAdapterError(c, new AdapterError(`Adapter '${id}' not found`, 'NOT_FOUND'));
    // No owner yet: the person at this computer confirms with no sheet.
    if (!ownerExists()) {
      const refused = noOwnerRefusal(c, CONFIRM_WORDING.personOnly);
      if (refused) return refused;
      const { status, body: answer } = await run(id, fingerprint, false);
      return c.json(answer, status as ContentfulStatusCode);
    }
    // "Confirm it's you" (DOR-3234, DOR-3467): held until the owner's step-up
    // passes. The commit re-checks the owner bar on the request that confirmed
    // it, then runs the same confirm, which re-reads the connection and refuses
    // with 409 if it changed since it was shown.
    return holdForStepUp(c, {
      kind: 'connection.confirm-setting',
      target: id,
      input: { id, fingerprint },
      reason: confirmReason(shown),
      commit: async (confirming) => {
        const stale = errorRefusalUnlessOwner(confirming, CONFIRM_WORDING);
        if (stale) return { status: 403, body: stale };
        return run(id, fingerprint, false);
      },
    });
  };
  router.post('/adapters/:id/confirm-references', (c) => handle(c, false));
  router.delete('/adapters/:id/confirm-references', (c) => handle(c, true));
}
