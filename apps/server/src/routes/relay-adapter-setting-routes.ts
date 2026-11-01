/**
 * The adapter routes that give a connection its settings: test, add and save
 * (`POST /adapters/test`, `POST /adapters`, `PATCH /adapters/:id/config`).
 *
 * A person's `env:` or `keychain:` setting reads the owner's own machine. Each
 * of these approves one (add, save) or resolves one (test), so when a
 * person's request carries one and the install has an owner, it is held for
 * "Confirm it's you" (DOR-3234, Security's #3401 M1), exactly as Confirm this
 * setting is. Without that, re-saving a paused connection with the same
 * setting would approve and unpause it on the cookie alone. A request with no
 * such setting, or from anything but the owner (which the secret rules treat
 * as an agent and never let approve one), runs as before.
 *
 * Split from {@link module:routes/relay-adapters} to keep that file under its
 * line ceiling.
 *
 * @module routes/relay-adapter-setting-routes
 */
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import {
  AdapterConfigUpdateSchema,
  AdapterCreateRequestSchema,
  AdapterTestRequestSchema,
} from '@dorkos/shared/relay-schemas';

import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { validationFailureBody } from '../lib/route-utils.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
import type { AdapterManager } from '../services/relay/adapter-manager.js';
import { isPersonReference, type SecretWriter } from '../services/relay/adapter-secret-policy.js';
import { errorRefusalUnlessOwner } from './cloud-owner-bar.js';
import {
  adapterResult,
  noOwnerRefusal,
  quotedName,
  secretWriter,
  settingName,
  settingNamesText,
} from './relay-adapter-http.js';
import { holdForStepUp } from './step-up-guard.js';

/** How these routes word a refusal: to anything but a person, and to a non-owner. */
const SETTING_WORDING = {
  personOnly: 'Only a person can give a connection this setting.',
  action: 'give a connection this setting',
};

/**
 * Every `env:`/`keychain:` setting anywhere in `value`, by name, in order.
 * Every string is checked, not only the secret fields: a field that holds one
 * by mistake is still a setting this would hand over.
 *
 * @param value - A request's `config`.
 */
export function personSettingsIn(value: unknown): string[] {
  const names: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      if (isPersonReference(node)) names.push(settingName(node));
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (typeof node === 'object' && node !== null) {
      Object.values(node).forEach(walk);
    }
  };
  walk(value);
  return [...new Set(names)];
}

/** One request that may hand a connection a person's setting. */
interface SettingUse {
  /** What it acts on, in the server's words. */
  target: string;
  /** Exactly what will run; its hash binds the statement. */
  input: unknown;
  /** The settings it carries, by name; none runs it as before. */
  settings: readonly string[];
  /** The sheet's sentence. */
  reason: string;
  /** Run it as `writer`, answering as the route would. */
  run: (writer: SecretWriter) => Promise<{ status: number; body: unknown }>;
}

/**
 * Run a request, or hold it for "Confirm it's you" when the owner's request
 * hands a connection a person's setting.
 *
 * @param c - The request.
 * @param use - See {@link SettingUse}.
 * @param ownerExists - Whether this install has an owner yet.
 */
async function runOrHold(
  c: Context<ApiEnv>,
  use: SettingUse,
  ownerExists: () => boolean
): Promise<Response> {
  const answer = (result: { status: number; body: unknown }) =>
    c.json(result.body as object, result.status as ContentfulStatusCode);
  const writer = secretWriter(c);
  if (writer !== 'person' || use.settings.length === 0) return answer(await use.run(writer));
  if (!ownerExists()) {
    // No owner yet: the person at this computer goes on with no sheet.
    return noOwnerRefusal(c, SETTING_WORDING.personOnly) ?? answer(await use.run('person'));
  }
  return holdForStepUp(c, {
    kind: 'connection.use-setting',
    target: use.target,
    input: use.input,
    reason: use.reason,
    // Re-checked on the request that confirmed it: still the owner.
    commit: async (confirming) => {
      const stale = errorRefusalUnlessOwner(confirming, SETTING_WORDING);
      if (stale) return { status: 403, body: stale };
      return use.run('person');
    },
  });
}

/** What the setting routes read. */
export interface SettingRouteDeps {
  adapterManager: AdapterManager;
  activity?: ActivityService;
  /** Whether this install has an owner yet; the owner account by default. */
  ownerExists?: () => boolean;
}

/**
 * Register the test, add and save routes on the adapter router.
 *
 * @param router - The adapter routes' router.
 * @param deps - See {@link SettingRouteDeps}.
 */
export function registerSettingRoutes(router: Hono<ApiEnv>, deps: SettingRouteDeps): void {
  const { adapterManager, activity } = deps;
  const ownerExists = deps.ownerExists ?? (() => readOwnerAccount() !== null);

  router.post('/adapters/test', async (c) => {
    const parsed = AdapterTestRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json(validationFailureBody(parsed.error), 400);
    const { type, config } = parsed.data;
    const settings = personSettingsIn(config);
    return runOrHold(
      c,
      {
        target: type,
        input: { op: 'test', type, config },
        settings,
        reason: `Lets a ${quotedName(type)} test read ${settingNamesText(settings)}.`,
        run: (writer) =>
          adapterResult(async () => {
            const body = await adapterManager.testConnection(type, config, writer);
            return { status: 200, body };
          }, 'Test failed'),
      },
      ownerExists
    );
  });

  router.post('/adapters', async (c) => {
    const parsed = AdapterCreateRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json(validationFailureBody(parsed.error), 400);
    const { type, id, config, enabled, label: topLabel } = parsed.data;
    // The client may embed label inside config (Transport interface doesn't have a separate
    // label param). Fall back to config.label if the top-level field wasn't provided.
    const label = topLabel ?? (typeof config.label === 'string' ? config.label : undefined);
    const actor = readActivityActor(honoRequestFacts(c));
    const settings = personSettingsIn(config);
    return runOrHold(
      c,
      {
        target: id,
        input: { op: 'add', type, id, config, enabled, label },
        settings,
        reason: `Lets ${quotedName(label ?? type)} use ${settingNamesText(settings)}.`,
        run: (writer) =>
          adapterResult(async () => {
            await adapterManager.addAdapter(type, id, config, enabled, label, writer);
            if (activity) {
              const adapterName = adapterManager.resolveAdapterName(id);
              await activity.emit({
                ...actor,
                category: 'relay',
                eventType: 'relay.adapter_added',
                resourceType: 'adapter',
                resourceId: id,
                resourceLabel: adapterName,
                summary: `Added ${adapterName} adapter`,
                linkPath: '/',
              });
            }
            return { status: 201, body: { ok: true, id } };
          }, 'Create failed'),
      },
      ownerExists
    );
  });

  router.patch('/adapters/:id/config', async (c) => {
    const parsed = AdapterConfigUpdateSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json(validationFailureBody(parsed.error), 400);
    const id = c.req.param('id') ?? '';
    const { config } = parsed.data;
    const settings = personSettingsIn(config);
    return runOrHold(
      c,
      {
        target: id,
        input: { op: 'save', id, config },
        settings,
        reason: `Lets ${quotedName(adapterManager.resolveAdapterName(id))} use ${settingNamesText(settings)}.`,
        run: (writer) =>
          adapterResult(async () => {
            await adapterManager.updateConfig(id, config, writer);
            return { status: 200, body: { ok: true } };
          }, 'Update failed'),
      },
      ownerExists
    );
  });
}
