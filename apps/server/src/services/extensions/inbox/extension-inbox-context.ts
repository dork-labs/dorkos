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
import { problemBody } from '@dorkos/http-kit';
import { PROBLEM_CONTENT_TYPE, type Problem, type ProblemCode } from '@dorkos/shared/problem';
import type { InboxApi, PersonCheck, ProjectSettingsReader } from '@dorkos/extension-api/server';
import type { RequestFacts } from '../../../http/request-facts.js';
import { expressRequestFacts } from '../http/express-bridge.js';
import { PERSON_APP_HEADER, PERSON_SESSION_REQUIRED_CODE } from '@dorkos/shared/person-session';
import {
  isPersonWithoutSession,
  PERSON_SESSION_REQUIRED_MESSAGE,
  personSessionWasMissing,
} from '../../../lib/person-without-session.js';
import { projectRegistry } from '../../projects/project-registry.js';
import { getExtensionInbox, type ExtensionInboxService } from './extension-inbox.js';
import { projectSettingsStore } from './extension-project-settings.js';
import { runInPersonRequest } from '../person-record/person-record.js';

/**
 * What one surface says when the person bar refuses, so the reader is told
 * what DorkOS did not do and what to do instead.
 */
export interface ExtensionPersonCopy {
  /** Machine-readable code for the origin and agent bars. */
  code: ProblemCode;
  /** What the cookie bar names as the thing being changed, as a noun phrase. */
  subject: string;
  /** The `detail` for a request that arrived from another site, given its origin. */
  crossSite: (origin: string) => string;
  /** The `detail` for a caller that named itself an agent. */
  agent: string;
}

/**
 * The person bar's verdict on one request: the refusal to answer with, or
 * `null` when a person is asking. Boot passes the extensions routes' own bar
 * (`assessPerson`), so an extension's routes refuse exactly as DorkOS's do.
 */
export type AssessExtensionPerson = (
  facts: RequestFacts,
  copy: ExtensionPersonCopy
) => { status: number; body: Problem } | null;

let assessExtensionPerson: AssessExtensionPerson | undefined;

/**
 * Wire the person bar every extension route and fetch handler runs. Boot
 * calls it once, before any extension serves a request.
 *
 * @param assess - The bar's verdict on one request.
 */
export function setExtensionPersonBar(assess: AssessExtensionPerson): void {
  assessExtensionPerson = assess;
}

/** The person bar, or a plain error when boot has not wired one: never an open door. */
function personBarOrThrow(): AssessExtensionPerson {
  if (!assessExtensionPerson) throw new Error('The DorkOS person bar is not wired yet.');
  return assessExtensionPerson;
}

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
 * What `ctx.requirePerson` says when it refuses, worded with the extension's
 * name. Shared by the in-process bar and the verdict the host computes for an
 * isolated extension (`isolation/isolated-router.ts`), so both refuse with the
 * same words.
 *
 * @param extensionName - The extension's manifest name.
 */
export function requirePersonCopy(extensionName: string): ExtensionPersonCopy {
  return {
    code: 'person_only',
    subject: `${extensionName}'s settings`,
    crossSite: (origin) =>
      `DorkOS changed nothing. ${origin} isn’t DorkOS. Change ${extensionName}'s settings in DorkOS.`,
    agent: `DorkOS changed nothing. Only a person can change ${extensionName}'s settings.`,
  };
}

/**
 * The person bar's verdict on one request, worded for one extension: what a
 * fetch handler is told about its caller (`ExtensionCaller.person`), and what
 * the host sends an extension in its own process, whose request carries no
 * cookie to decide it from.
 *
 * @param request - The real request's facts (its cookie, headers and the
 *   identity the chain resolved).
 * @param extensionName - The extension's manifest name.
 */
export function personVerdict(request: RequestFacts, extensionName: string): PersonCheck {
  const refusal = extensionPersonRefusal(request, extensionName);
  return refusal ? { ok: false, status: refusal.status, body: refusal.body } : { ok: true };
}

/**
 * The person bars for an extension's own route, or `null` when a person is
 * asking. Every method asks (DOR-3330): DorkOS cannot know that an
 * extension's `GET` changes nothing, so its method is not read. The person at
 * this computer missing only their session is answered with the step-up code,
 * so the app asks their password once.
 */
function extensionPersonRefusal(request: RequestFacts, extensionName: string) {
  const facts: RequestFacts = { ...request, method: undefined };
  const refusal = personBarOrThrow()(facts, requirePersonCopy(extensionName));
  const fromTheApp = facts.headers[PERSON_APP_HEADER] !== undefined;
  if (refusal && fromTheApp && personSessionWasMissing(facts) && isPersonWithoutSession(facts)) {
    const body = problemBody(PERSON_SESSION_REQUIRED_CODE, {
      detail: PERSON_SESSION_REQUIRED_MESSAGE,
    });
    return { status: body.status, body };
  }
  return refusal;
}

/**
 * `ctx.requirePerson`: the bar that guards approving an extension, in front of
 * one of the extension's own routes, worded with its name (§7.6). Once an
 * owner exists it needs their session at this computer too (DOR-3330); the
 * extension's own page code, in the person's window, still passes.
 *
 * The rest of an admitted request runs as that person's request until its
 * response ends, so `ctx.personRecord.record` works inside it and nowhere else
 * (DOR-4301).
 *
 * @param extensionId - The extension whose route it guards.
 * @param extensionName - The extension's manifest name.
 */
export function createRequirePerson(extensionId: string, extensionName: string): RequestHandler {
  return (req, res, next) => {
    const refusal = extensionPersonRefusal(expressRequestFacts(req, res), extensionName);
    if (refusal) {
      res.status(refusal.status).type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(refusal.body));
      return;
    }
    runInPersonRequest(extensionId, (end) => {
      // Either ends the request: `finish` once it is answered, `close` if the socket goes first.
      res.once('finish', end);
      res.once('close', end);
      next();
    });
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
