/**
 * The one answer to "can agents use this account right now, and if not, what
 * is the one fix and who can make it?" (`ConnectionReadiness`).
 *
 * Every surface reads it: the owner's connection list and detail, an agent's
 * granted-connections list (`unavailable[]`), execution refusals and the chat
 * card. None of them decides usability from raw fields again. This module
 * reads facts other parts of the server write (the stored lifecycle, sign-in
 * status, review status and access sync, and the live health of the way the
 * account was connected through); it never refreshes them.
 *
 * ## Truth table
 *
 * The first matching row wins, top to bottom. "Cleanup owed" is any external
 * cleanup other than complete or not required. "Another way works" means a
 * different way DorkOS reaches apps answers and can run actions.
 *
 * | #  | Facts                                                                  | state         | reason                       | fix (by)                           |
 * | -- | ---------------------------------------------------------------------- | ------------- | ---------------------------- | ---------------------------------- |
 * | 1  | disconnected, nothing owed, way up                                     | `gone`        | `disconnected`               | `connect_again` (person)           |
 * | 2  | disconnected, nothing owed, way down                                   | `gone`        | `disconnected`               | `connect_new` (person)             |
 * | 3  | disconnected, cleanup owed, access sync pending, way up                | `gone`        | `disconnect_finishing`       | `retry` (dorkos, retryAt)          |
 * | 4  | disconnected, cleanup owed, access sync pending, DorkOS account can't reach apps | `gone` | `disconnect_finishing` | `wait` (dorkos, retryAt)           |
 * | 5  | disconnected, cleanup owed, way down: own key refused (no re-check due) | `gone`       | `disconnect_stuck`           | `fix_key` (person)                 |
 * | 6  | disconnected, cleanup owed, way down: anything else                    | `gone`        | `disconnect_stuck`           | none                               |
 * | 7  | disconnected, cleanup unknown, DorkOS account                          | `gone`        | `disconnect_stuck`           | none                               |
 * | 8  | disconnected, cleanup owed, way up                                     | `gone`        | `disconnect_failed`          | `retry` (person)                   |
 * | 9  | turned off for this chat, the owner's chat view can turn it on         | `unavailable` | `off_for_this_chat`          | `turn_on_for_this_chat` (person)   |
 * | 9b | turned off for this chat, anything else (agent views, nothing to put back) | `unavailable` | `off_for_this_chat`      | none                               |
 * | 10 | way down: DorkOS account not linked                                    | `needs_you`   | `dorkos_account_unlinked`    | `connect_new` (person)             |
 * | 11 | way down: DorkOS account can't reach apps                              | `unavailable` | `dorkos_account_unavailable` | `retry` (dorkos, retryAt if a re-check is due) |
 * | 12 | way down: own key, DorkOS checks it again on its own (a timeout, an outage) | `unavailable` | `own_key_unavailable` | `wait` (dorkos, retryAt)           |
 * | 12b | way down: own key refused, removed or not set up                      | `needs_you`   | `own_key_unavailable`        | `fix_key` (person)                 |
 * | 13 | way down: nothing DorkOS can name                                      | `unavailable` | `way_unreachable`            | `connect_new` if another way works |
 * | 14 | way up but can't run actions, a key would fix it                       | `needs_you`   | `own_key_cannot_run_actions` | `fix_key` (person)                 |
 * | 15 | way up but can't run actions, nothing would fix it                     | `unavailable` | `cannot_run_actions`         | `connect_new` if another way works |
 * | 16 | sign-in expired or revoked (paused or not)                             | `needs_you`   | `signed_out`                 | `sign_in_again` (person)           |
 * | 17 | sign-in pending (paused or not)                                        | `needs_you`   | `sign_in_unfinished`         | `sign_in_again` (person)           |
 * | 18 | paused                                                                 | `paused`      | `paused`                     | `resume` (person)                  |
 * | 19 | needs review                                                           | `needs_you`   | `needs_review`               | `review_access` (person)           |
 * | 20 | access sync failed                                                     | `needs_you`   | `access_update_failed`       | `review_access` (person)           |
 * | 21 | access sync pending                                                    | `finishing`   | `access_updating`            | `wait` (dorkos, retryAt)           |
 * | 22 | everything else                                                        | `ready`       | `usable`                     | none                               |
 *
 * Why the way comes before paused and signed out: while it is down, resuming
 * or signing in again cannot make the account usable, so those would be
 * buttons that can't work. Why signed out comes before paused: a sign-in
 * again that completes also resumes the account, while resuming a signed-out
 * account still leaves it unusable. Access sync is the caller's to choose:
 * the owner's account view passes the account-wide state, an agent's or a
 * chat's view passes that agent's own (`managedAgentAccess`), and execution
 * checks the agent's own.
 *
 * @module services/connectors/connection-readiness
 */
import {
  CONNECT_ANOTHER_WAY_COPY,
  CONNECTION_GONE_AGENT_COPY,
  CONNECTION_READINESS_COPY,
  ConnectionReadinessSchema,
  disconnectStuckOwnerLine,
  TELL_THE_PERSON_AGENT_COPY,
  TURN_ON_FOR_THIS_CHAT_COPY,
  WAY_RECHECK_COPY,
  type ConnectionDisconnectStuckCause,
  type ConnectionFix,
  type ConnectionReadiness,
  type ConnectionReadinessCopy,
  type ConnectionReadinessReason,
  type ConnectionReadinessState,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorProvider } from '@dorkos/shared/connector-provider';
import type { ConnectorAuthoritySyncState } from '@dorkos/shared/connector-resource-schemas';
import type { ConnectorWayProblem } from '../app-connection-way.js';
import type { ConnectorRegistry } from '../registry.js';

/**
 * The live health of the way one account was connected through.
 *
 * - `up`, `canRunActions: true` — it answers and can run actions.
 * - `up`, `canRunActions: false` — it signs in to apps but can't run their
 *   actions; `keyCanFix` when a different key of the person's own would.
 * - `down` — it isn't answering; `problem` names which way and so which fix,
 *   or `unreachable` when DorkOS can't name one.
 *
 * `anotherWayWorks` says whether connecting the app again another way could
 * help, when nothing fixes this one.
 */
export type ConnectionWayHealth =
  | { readonly status: 'up'; readonly canRunActions: true }
  | {
      readonly status: 'up';
      readonly canRunActions: false;
      readonly keyCanFix: boolean;
      /** Another way DorkOS reaches apps answers and can run actions. */
      readonly anotherWayWorks: boolean;
    }
  | {
      readonly status: 'down';
      readonly problem: ConnectorWayProblem | 'unreachable';
      /** Another way DorkOS reaches apps answers and can run actions. */
      readonly anotherWayWorks: boolean;
      /**
       * When DorkOS checks this way again on its own, after it failed for a
       * reason that may pass (a timeout, an outage). Absent when it waits for
       * the person (a refused key, a refused link) or nothing is scheduled.
       */
      readonly nextCheckAt?: string;
    };

/** Reads the live health of the way behind one provider instance. */
export type ConnectionWayHealthPort = (providerInstanceId: string) => ConnectionWayHealth;

/**
 * The health of one way from its live route: down (with the fix `problem`
 * names, else `unreachable`) when nothing is registered, otherwise up and
 * whether agents can act through it ({@link keyCanFixActions} says whether a
 * key fixes a route that can't).
 *
 * @param live - The registered route, if any.
 * @param problem - Why the way is down, when a known way is.
 * @param anotherWayWorks - Whether a different way answers and can run actions.
 * @param nextCheckAt - When DorkOS checks a way that is down again on its own, if it will.
 */
export function wayHealthOf(
  live: ConnectorProvider | undefined,
  problem: () => ConnectorWayProblem | undefined,
  anotherWayWorks: () => boolean = () => false,
  nextCheckAt: () => string | undefined = () => undefined
): ConnectionWayHealth {
  if (!live) {
    const checkAt = nextCheckAt();
    return {
      status: 'down',
      problem: problem() ?? 'unreachable',
      anotherWayWorks: anotherWayWorks(),
      ...(checkAt !== undefined && { nextCheckAt: checkAt }),
    };
  }
  if (live.getCapabilities().capabilities.execution.status === 'available') {
    return { status: 'up', canRunActions: true };
  }
  return {
    status: 'up',
    canRunActions: false,
    keyCanFix: keyCanFixActions(live),
    anotherWayWorks: anotherWayWorks(),
  };
}

/**
 * Whether a different key of the person's own would let a route that can't
 * run actions run them: only a Composio account key, which a project key
 * replaces. A self-hosted Nango server never runs them, whatever its key.
 *
 * @param live - A registered route that can't run actions.
 */
export function keyCanFixActions(live: ConnectorProvider): boolean {
  return live.type === 'composio';
}

/**
 * The way-health reader for a service built without the bootstrapper's (a
 * test, or a server with no credential-gated ways): the live registry only.
 *
 * @param registry - Registered providers.
 */
export function registryWayHealth(registry: ConnectorRegistry): ConnectionWayHealthPort {
  return (providerInstanceId) =>
    wayHealthOf(
      registry.resolveProviderInstance(providerInstanceId as ConnectorProvider['instanceId']),
      () => undefined
    );
}

/** Everything readiness is decided from, as other parts of the server store it. */
export interface ConnectionReadinessFacts {
  /** `connected`, `paused` (the owner turned it off) or `disconnected`. */
  readonly lifecycle: 'connected' | 'paused' | 'disconnected';
  /** The stored sign-in status. */
  readonly authenticationStatus: 'active' | 'expired' | 'revoked' | 'pending';
  /** Whether who can use it has to be checked again. */
  readonly reconciliationStatus: 'ready' | 'migration_needs_reconcile';
  /**
   * Access sync: account-wide in the owner's account view, the agent's own in
   * an agent's or a chat's view. Omitted when nothing is synced (own key).
   */
  readonly authoritySync?: ConnectorAuthoritySyncState;
  /** What is still owed at the service after a disconnect. */
  readonly externalCleanup?: 'not_required' | 'pending' | 'complete' | 'failed' | 'unknown';
  /** `managed` for an account connected through the DorkOS account. */
  readonly mode: 'managed' | 'byo';
  /** The live health of the way it was connected through. */
  readonly way: ConnectionWayHealth;
  /** True when this chat turned the account off for its agent. */
  readonly offForThisChat?: boolean;
  /**
   * True when the owner's per-chat switch can turn it back on here: set only
   * by the owner's view of a chat, for an account the agent holds
   * account-wide. Agent views never set it, so an agent is never offered it.
   */
  readonly canTurnOnForThisChat?: boolean;
}

/** Build and check one readiness value, its words from the one copy table. */
function readiness(
  state: ConnectionReadinessState,
  reason: Exclude<ConnectionReadinessReason, 'disconnect_stuck'>,
  fix?: ConnectionFix,
  extra?: Partial<ConnectionReadinessCopy>
): ConnectionReadiness {
  const words = CONNECTION_READINESS_COPY[reason];
  const join = (base: string, more: string | undefined) => (more ? `${base} ${more}` : base);
  return ConnectionReadinessSchema.parse({
    state,
    reason,
    ...(fix && { fix }),
    copy: { owner: join(words.owner, extra?.owner), agent: join(words.agent, extra?.agent) },
  });
}

/** A disconnect DorkOS can't finish right now, and the one thing the person can do. */
function stuck(cause: ConnectionDisconnectStuckCause, fix?: ConnectionFix): ConnectionReadiness {
  return ConnectionReadinessSchema.parse({
    state: 'gone',
    reason: 'disconnect_stuck',
    ...(fix && { fix }),
    copy: { owner: disconnectStuckOwnerLine(cause), agent: CONNECTION_GONE_AGENT_COPY },
  });
}

/**
 * An account nothing here can fix, as `unavailable`: when another way works,
 * connecting it again that way is the fix; otherwise there is no button, and
 * the agent is told to tell the person.
 */
function unfixable(
  reason: 'way_unreachable' | 'cannot_run_actions',
  anotherWayWorks: boolean
): ConnectionReadiness {
  return anotherWayWorks
    ? readiness(
        'unavailable',
        reason,
        { action: 'connect_new', fixableBy: 'person' },
        CONNECT_ANOTHER_WAY_COPY
      )
    : readiness('unavailable', reason, undefined, { agent: TELL_THE_PERSON_AGENT_COPY });
}

/** When DorkOS tries an access change again, if the stored sync says. */
function retryAtOf(sync: ConnectorAuthoritySyncState | undefined): { retryAt?: string } {
  return sync?.status === 'pending' && sync.retryAt ? { retryAt: sync.retryAt } : {};
}

function disconnectedReadiness(facts: ConnectionReadinessFacts): ConnectionReadiness {
  const { way, externalCleanup: cleanup } = facts;
  const wayUp = way.status === 'up';
  if (cleanup === undefined || cleanup === 'complete' || cleanup === 'not_required') {
    return readiness('gone', 'disconnected', {
      action: wayUp ? 'connect_again' : 'connect_new',
      fixableBy: 'person',
    });
  }
  if (facts.authoritySync?.status === 'pending') {
    // DorkOS keeps trying on its own. "Try again now" only helps while the way
    // answers; otherwise there is nothing to press.
    if (wayUp) {
      return readiness('gone', 'disconnect_finishing', {
        action: 'retry',
        fixableBy: 'dorkos',
        ...retryAtOf(facts.authoritySync),
      });
    }
    if (way.problem === 'dorkos_account_unavailable') {
      return readiness('gone', 'disconnect_finishing', {
        action: 'wait',
        fixableBy: 'dorkos',
        ...retryAtOf(facts.authoritySync),
      });
    }
  }
  if (way.status === 'down') {
    // Fixing the key helps only when the key was refused, not when DorkOS is
    // still waiting to check it again.
    return way.problem === 'own_key_unavailable' && !way.nextCheckAt
      ? stuck(way.problem, { action: 'fix_key', fixableBy: 'person' })
      : stuck(way.problem === 'own_key_unavailable' ? 'unreachable' : way.problem);
  }
  // An account closed because a new DorkOS account link couldn't reach it:
  // disconnecting again goes to a link that doesn't know it, so it can't work.
  if (cleanup === 'unknown' && facts.mode === 'managed') return stuck('unconfirmed');
  return readiness('gone', 'disconnect_failed', { action: 'retry', fixableBy: 'person' });
}

/**
 * Decide whether agents can use one account right now and, if not, the one
 * fix. The only place in DorkOS that decides it; see the module's truth table.
 *
 * @param facts - The account's stored facts and its way's live health.
 */
export function deriveConnectionReadiness(facts: ConnectionReadinessFacts): ConnectionReadiness {
  if (facts.lifecycle === 'disconnected') return disconnectedReadiness(facts);
  if (facts.offForThisChat) {
    return facts.canTurnOnForThisChat
      ? readiness(
          'unavailable',
          'off_for_this_chat',
          { action: 'turn_on_for_this_chat', fixableBy: 'person' },
          TURN_ON_FOR_THIS_CHAT_COPY
        )
      : readiness('unavailable', 'off_for_this_chat');
  }
  const { way } = facts;
  if (way.status === 'down') {
    switch (way.problem) {
      case 'dorkos_account_unlinked':
        return readiness('needs_you', 'dorkos_account_unlinked', {
          action: 'connect_new',
          fixableBy: 'person',
        });
      case 'dorkos_account_unavailable':
        return readiness('unavailable', 'dorkos_account_unavailable', {
          action: 'retry',
          fixableBy: 'dorkos',
          ...(way.nextCheckAt && { retryAt: way.nextCheckAt }),
        });
      case 'own_key_unavailable':
        // A key that failed for a reason that may pass is DorkOS's to check
        // again; one the service refused waits for the person to fix it.
        return way.nextCheckAt
          ? ConnectionReadinessSchema.parse({
              state: 'unavailable',
              reason: 'own_key_unavailable',
              fix: { action: 'wait', fixableBy: 'dorkos', retryAt: way.nextCheckAt },
              copy: WAY_RECHECK_COPY,
            })
          : readiness('needs_you', 'own_key_unavailable', {
              action: 'fix_key',
              fixableBy: 'person',
            });
      case 'unreachable':
        return unfixable('way_unreachable', way.anotherWayWorks);
    }
  }
  if (!way.canRunActions) {
    return way.keyCanFix
      ? readiness('needs_you', 'own_key_cannot_run_actions', {
          action: 'fix_key',
          fixableBy: 'person',
        })
      : unfixable('cannot_run_actions', way.anotherWayWorks);
  }
  // Signing in again resumes the account when it completes; resuming a
  // signed-out account would still leave it unusable.
  if (facts.authenticationStatus === 'expired' || facts.authenticationStatus === 'revoked') {
    return readiness('needs_you', 'signed_out', { action: 'sign_in_again', fixableBy: 'person' });
  }
  if (facts.authenticationStatus === 'pending') {
    return readiness('needs_you', 'sign_in_unfinished', {
      action: 'sign_in_again',
      fixableBy: 'person',
    });
  }
  if (facts.lifecycle === 'paused') {
    return readiness('paused', 'paused', { action: 'resume', fixableBy: 'person' });
  }
  if (facts.reconciliationStatus !== 'ready') {
    return readiness('needs_you', 'needs_review', { action: 'review_access', fixableBy: 'person' });
  }
  if (facts.authoritySync?.status === 'failed') {
    return readiness('needs_you', 'access_update_failed', {
      action: 'review_access',
      fixableBy: 'person',
    });
  }
  if (facts.authoritySync?.status === 'pending') {
    return readiness('finishing', 'access_updating', {
      action: 'wait',
      fixableBy: 'dorkos',
      ...retryAtOf(facts.authoritySync),
    });
  }
  return readiness('ready', 'usable');
}
