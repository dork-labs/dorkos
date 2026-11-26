/**
 * The person's extension doors the capability mount serves on
 * `/api/extensions` (ADR 261123-170830, DOR-4978): "Not now", removing an
 * extension, forgetting the approval of one that is gone, and restarting one
 * that stopped too often.
 *
 * **Behind the person bar, every door** (`http.callerBar: 'person'`,
 * `lib/http/person-bar.ts`), and `audience: 'person'`, so every list an agent
 * reads shows them closed to agents. The mount runs the bar before the handler
 * and before the input is read, on the REST path and on `/invoke` alike, with
 * the copy each door declares here. Code from strangers needs a yes, so no
 * agent ever approves, removes, forgets, restarts or turns off an extension;
 * there is no MCP surface. With login off a program holding a key still passes
 * the bar, as it did on the hand routes; it is recorded as a program
 * (`personBarActivityActor`), never as the person.
 *
 * Every refusal is a fixed sentence (`extension-door-words.ts`). The rest of
 * the group stays a hand route for now (`routes/extensions*.ts`): approving and
 * "Allow all" (they wait on "Confirm it's you"), turning one on and the trusted
 * sources (front-door writes), taking a yes back and turning one off (their
 * paths' verbs are an API-lint ratchet that may not rise), and the reads. A
 * Wi-Fi sign-in is refused all four before the mount, by the Wi-Fi level's
 * refused-route list, as on the hand routes.
 *
 * @module services/extensions/http-capabilities/extension-person-capabilities
 */
import { z } from 'zod';
import type { HttpSurface } from '@dorkos/shared/capabilities';
import { DismissExtensionApprovalRequestSchema } from '@dorkos/shared/extension-approval-schemas';

import {
  CapabilityToolError,
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
} from '../../core/capabilities/capability-definition.js';
import type { CapabilityHandlerContext } from '../../core/capabilities/registry.js';
import type { ActivityService } from '../../activity/activity-service.js';
import { personBarActivityActor } from '@dorkos/shared/activity-schemas';
import type { ActivityActor } from '../../activity/activity-actor.js';
import type { ExtensionManager } from '../extension-manager.js';
import { forgetStaleApproval, removeExtension } from '../removal/extension-removal.js';
import { logger } from '../../../lib/logger.js';
import {
  APPROVAL_BAR,
  REMOVAL_BAR,
  REMOVE_REFUSAL_COPY,
  RESTART_BAR,
  SAFE_EXT_ID,
} from './extension-door-words.js';

/** What the extension doors read. */
export interface ExtensionPersonDeps {
  /** The extension manager, for lifecycle operations. */
  readonly manager: ExtensionManager;
  /** Tells every open window an extension changed. */
  readonly broadcastReloaded: (ids: string[]) => void;
  /** The Activity feed each change is recorded in, when the server has one. */
  readonly activity?: Pick<ActivityService, 'emit'>;
}

declare module '../../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** The person's extension doors on `/api/extensions` (DOR-4978). */
    extensionPersonDeps?: ExtensionPersonDeps;
  }
}

/**
 * The deps, or a fault: the domain is composed only with them.
 *
 * @param deps - The registry's deps.
 */
export function extensionPersonDepsOf(deps: CapabilityDeps): ExtensionPersonDeps {
  if (!deps.extensionPersonDeps) throw new Error('Extension doors are unavailable.');
  return deps.extensionPersonDeps;
}

/** A refusal from the fixed table (`EXTENSION_DOOR_TOOL_REFUSALS`). */
function refuse(code: string, error = code): never {
  throw new CapabilityToolError({ code, error });
}

/**
 * Who acted, from the person bar's own pass: the person in the app, or a
 * program with a key. The registry refuses the call before the handler when
 * there is no pass, so the fallback never names anyone.
 */
function actorOf(context: CapabilityHandlerContext): ActivityActor {
  return personBarActivityActor(context.personBar?.caller ?? 'program');
}

/** A failure DorkOS did not expect: logged, and answered with a fixed sentence. */
function failed(what: string, id: string, error: unknown, sentence: string): never {
  if (error instanceof CapabilityToolError) throw error;
  logger.error(`[Extensions] Failed to ${what} ${id}`, error);
  refuse('EXTENSION_DOOR_FAILED', sentence);
}

/** The bar and audience every door declares, with that door's copy. */
function personDoor(path: string, personCopy: HttpSurface['personCopy'], success?: 204) {
  return {
    method: 'post',
    path,
    audience: 'person',
    callerBar: 'person',
    personCopy,
    ...(success ? { success } : {}),
  } as const satisfies HttpSurface;
}

/** Why no agent reaches these doors, for the catalog. */
const PERSON_ONLY_NOTE =
  'a person’s own mini app switches; agents build and reload mini apps with their own tools';

/** The extension a path names. */
function extensionId(message = 'Use an extension id in lowercase, like my-extension.') {
  return z.string().regex(SAFE_EXT_ID, { message }).describe('The extension’s id.');
}

/** `extensions.dismiss_approval`: "Not now" for this copy at this version. */
export const dismissApprovalCapability = defineCapability({
  id: 'extensions.dismiss_approval',
  title: 'Not now: stop asking about an extension',
  description:
    'Record that a person declined this copy of an extension at this version, so the Activity ' +
    'inbox stops asking until its path, plugin or version changes. Nothing is removed, turned ' +
    'off or revoked. The body names the copy the person was shown. Only a person.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: DismissExtensionApprovalRequestSchema.extend({ id: extensionId() }),
  // Nothing: the route answers 204 with no body.
  output: z.unknown(),
  surfaces: {
    http: personDoor('/api/extensions/{id}/dismiss-approval', APPROVAL_BAR, 204),
  },
  invoke: async (deps, { id, ...expected }) => {
    const { manager } = extensionPersonDepsOf(deps);
    try {
      const result = manager.dismissApproval(id, expected);
      if (result.ok) return;
      if (result.reason === 'not_found') refuse('EXTENSION_NOT_INSTALLED');
      if (result.reason === 'core') {
        refuse('EXTENSION_SHIPS_WITH_DORKOS');
      }
      refuse('EXTENSION_CHANGED_SINCE_SEEN');
    } catch (error) {
      failed('dismiss the approval for', id, error, 'Couldn’t save that. Try again.');
    }
  },
});

/** `extensions.remove`: delete an installed extension and everything it was allowed. */
export const removeExtensionCapability = defineCapability({
  id: 'extensions.remove',
  title: 'Remove an extension',
  description:
    'Forget every approval and choice recorded for this copy, then delete its folder and rescan. ' +
    'Only a folder DorkOS puts extensions in is deleted: a plugin-carried copy is removed by ' +
    'uninstalling the plugin, a dev link by unlinking it, and a DorkOS extension not at all. ' +
    'Only a person.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({ id: extensionId() }),
  output: z.object({ removed: z.string().describe('The id of the extension removed.') }),
  surfaces: { http: personDoor('/api/extensions/{id}/remove', REMOVAL_BAR) },
  invoke: async (deps, { id }, context) => {
    const { manager, activity, broadcastReloaded } = extensionPersonDepsOf(deps);
    try {
      const result = await removeExtension(manager, id);
      if (!result.ok) {
        if (result.reason === 'not_found') refuse('EXTENSION_NOT_INSTALLED');
        refuse('EXTENSION_REMOVE_REFUSED', REMOVE_REFUSAL_COPY[result.reason]);
      }
      await activity?.emit({
        ...actorOf(context),
        category: 'config',
        eventType: 'config.extension_updated',
        resourceType: 'extension',
        resourceId: id,
        resourceLabel: result.name,
        summary: `Removed ${result.name} and everything it was allowed`,
      });
      broadcastReloaded([id]);
      return { removed: id };
    } catch (error) {
      failed('remove', id, error, 'Couldn’t remove the extension. Try again.');
    }
  },
});

/** `extensions.forget_approval`: forget the yes for an extension that is gone. */
export const forgetApprovalCapability = defineCapability({
  id: 'extensions.forget_approval',
  title: 'Forget a removed extension’s approval',
  description:
    'Clear the run approval, approved source, permission set and "Not now" recorded for an ' +
    'extension id that is installed nowhere, so a folder put back at that path asks again. ' +
    'Only a person.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({ id: extensionId() }),
  // Nothing: the route answers 204 with no body.
  output: z.unknown(),
  surfaces: { http: personDoor('/api/extensions/{id}/forget', REMOVAL_BAR, 204) },
  invoke: async (deps, { id }, context) => {
    const { manager, activity, broadcastReloaded } = extensionPersonDepsOf(deps);
    try {
      const result = await forgetStaleApproval(manager, id);
      if (!result.ok) {
        refuse(
          result.reason === 'installed' ? 'EXTENSION_STILL_INSTALLED' : 'EXTENSION_NO_APPROVAL_LEFT'
        );
      }
      await activity?.emit({
        ...actorOf(context),
        category: 'config',
        eventType: 'config.extension_updated',
        resourceType: 'extension',
        resourceId: id,
        resourceLabel: id,
        summary: `Forgot what ${id} was allowed: its folder is gone`,
      });
      broadcastReloaded([id]);
    } catch (error) {
      failed('forget the approval for', id, error, 'Couldn’t forget the approval. Try again.');
    }
  },
});

/** Whether a person approved the copy on disk to run, as the cards report it. */
function approvedToRun(manager: ExtensionManager, id: string): boolean {
  return manager.listPublic().find((ext) => ext.id === id)?.approvedToRun === true;
}

/** `extensions.restart`: rebuild and start an extension that stopped too often. */
export const restartExtensionCapability = defineCapability({
  id: 'extensions.restart',
  title: 'Restart an extension',
  description:
    'Rebuild an extension that stopped too often, give it a fresh crash budget and start it ' +
    'again. Never turns one back on, and never runs a copy a person has not approved. Only a person.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({ id: extensionId('Couldn’t find that app.') }),
  output: z
    .object({
      id: z.string(),
      status: z.string().describe('`compiled`: it built and started.'),
      bundleReady: z.boolean(),
      sourceHash: z.string().optional(),
    })
    .describe('The reload’s result.'),
  surfaces: { http: personDoor('/api/extensions/{id}/restart', RESTART_BAR) },
  invoke: async (deps, { id }) => {
    const { manager, broadcastReloaded } = extensionPersonDepsOf(deps);
    const record = manager.get(id);
    if (!record) refuse('EXTENSION_APP_NOT_INSTALLED');
    // Never runs bytes a person has not approved (Security, DOR-4785): asked
    // before the reload, and again after it, since the reload's own pin check
    // is what notices files that changed since the yes.
    if (!approvedToRun(manager, id)) refuse('EXTENSION_NEEDS_APPROVAL');
    try {
      const result = await manager.reloadExtension(id);
      if (result.status !== 'compiled') {
        logger.warn(`[Extensions] Restart of ${id} did not build`, result.error);
        refuse('EXTENSION_RESTART_REFUSED', 'It no longer builds. Open Settings to see why.');
      }
      broadcastReloaded([id]);
      if (!approvedToRun(manager, id)) refuse('EXTENSION_NEEDS_APPROVAL');
      // A successful client build does not prove the server half started.
      if ((record.hasServerEntry || record.hasDataProxy) && !manager.getServerHandler(id)) {
        refuse('EXTENSION_SERVER_NOT_STARTED');
      }
      return result;
    } catch (error) {
      if (error instanceof CapabilityToolError) throw error;
      // Turned off since (the reload refuses it rather than turning it back on), or a
      // check after the reload threw: the hand route's one answer for both.
      logger.warn(`[Extensions] Restart of ${id} refused`, error);
      refuse('EXTENSION_RESTART_REFUSED');
    }
  },
});

/** The person's extension doors, served on `/api/extensions` by the mount. */
export const extensionPersonDomain: CapabilityDomain = {
  name: 'extensions',
  assertDeps: extensionPersonDepsOf,
  capabilities: [
    dismissApprovalCapability,
    removeExtensionCapability,
    forgetApprovalCapability,
    restartExtensionCapability,
  ],
};
