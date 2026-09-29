/**
 * The three `ctx` members that keep an extension's asks and settings with a
 * person (spec `flow-multiproject` §7.1, §7.6, §7.10): `ctx.inbox`,
 * `ctx.requirePerson` and the read-only `ctx.projectSettings`.
 *
 * Each is built per extension instance and scoped to its id. Everything the
 * instance registers (its action handler, its settings listeners) is tracked,
 * so `release` removes it when the extension shuts down or reloads.
 *
 * @module services/extensions/extension-inbox-context
 */
import type { RequestHandler } from 'express';
import type { InboxApi, ProjectSettingsReader } from '@dorkos/extension-api/server';
import { refuseIfNotAPerson, type PersonBarCopy } from '../../../routes/extensions-person-bar.js';
import { projectRegistry } from '../../projects/project-registry.js';
import { getExtensionInbox, type ExtensionInboxService } from './extension-inbox.js';
import { projectSettingsStore } from './extension-project-settings.js';

/** The inbox, or a plain error when boot has not wired one. */
function inboxOrThrow(): ExtensionInboxService {
  const inbox = getExtensionInbox();
  if (!inbox) throw new Error('The DorkOS inbox is not available yet.');
  return inbox;
}

/**
 * Build one extension's {@link InboxApi}.
 *
 * @param extensionId - The extension it answers for.
 * @param extensionName - Its manifest name, which is what rows and pushes say.
 */
export function createInboxApi(
  extensionId: string,
  extensionName: string
): { inbox: InboxApi; release: () => void } {
  let unregister: (() => void) | null = null;
  let released = false;

  const inbox: InboxApi = {
    raise: (input) => inboxOrThrow().raise(extensionId, extensionName, input),
    resolve: (key, opts) => inboxOrThrow().resolve(extensionId, key, opts),
    record: (input) => inboxOrThrow().record(extensionId, extensionName, input),
    list: async () => inboxOrThrow().list(extensionId),
    onAction(handler) {
      if (released) {
        throw new Error(
          `inbox.onAction was called after the extension "${extensionId}" shut down or reloaded.`
        );
      }
      if (typeof handler !== 'function')
        throw new TypeError('inbox.onAction needs a handler function.');
      unregister?.();
      const remove = inboxOrThrow().setHandler(extensionId, handler);
      let removed = false;
      const once = () => {
        if (removed) return;
        removed = true;
        if (unregister === once) unregister = null;
        remove();
      };
      unregister = once;
      return once;
    },
  };

  return {
    inbox,
    release: () => {
      released = true;
      unregister?.();
    },
  };
}

/**
 * `ctx.requirePerson`: the bar that guards approving an extension, in front of
 * one of the extension's own routes, worded with its name (§7.6). It has the
 * same residuals: with Require login off, a local caller that does not name
 * itself an agent passes, and in any posture the extension's own page code
 * passes.
 *
 * @param extensionName - The extension's manifest name.
 */
export function createRequirePerson(extensionName: string): RequestHandler {
  const copy: PersonBarCopy = {
    error: `Only a person can change ${extensionName}'s settings.`,
    code: 'extension_person_required',
    subject: `${extensionName}'s settings`,
    crossSite: (origin) =>
      `DorkOS changed nothing. This request came from ${origin}, which is not DorkOS. ` +
      `Only a person using DorkOS can change ${extensionName}'s settings.`,
    agent:
      `DorkOS changed nothing. Only a person can change ${extensionName}'s settings. ` +
      `Ask them to do it in DorkOS.`,
  };
  return (req, res, next) => {
    if (refuseIfNotAPerson(req, res, copy)) return;
    next();
  };
}

/**
 * `ctx.projectSettings`: read-only. There is no setter here on purpose, so
 * neither the extension's server half nor any agent it runs can move a
 * setting only a person should change.
 *
 * @param extensionId - The extension.
 * @param dorkHome - The DorkOS data directory.
 */
export function createProjectSettingsReader(
  extensionId: string,
  dorkHome: string
): { projectSettings: ProjectSettingsReader; release: () => void } {
  const store = projectSettingsStore(dorkHome);
  const removers = new Set<() => void>();
  const projectSettings: ProjectSettingsReader = {
    async get<T = unknown>(projectRoot: string): Promise<T | null> {
      if (typeof projectRoot !== 'string' || !projectRoot) return null;
      const resolved = await projectRegistry
        .resolveWithin(projectRoot, extensionId)
        .catch(() => null);
      if (!resolved || resolved === 'outside') return null;
      const stored = await store.read(extensionId, resolved.root);
      return (stored?.value as T | undefined) ?? null;
    },
    onChange(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('projectSettings.onChange needs a listener function.');
      }
      const remove = store.onChange((changedExtension, root) => {
        if (changedExtension === extensionId) listener(root);
      });
      removers.add(remove);
      return () => {
        removers.delete(remove);
        remove();
      };
    },
  };
  return {
    projectSettings,
    release: () => {
      for (const remove of [...removers]) remove();
      removers.clear();
    },
  };
}
