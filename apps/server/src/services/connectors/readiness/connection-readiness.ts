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
 * The first matching row wins, top to bottom.
 *
 * | # | Facts                                                        | state         | reason                        | fix (by)                      |
 * | - | ------------------------------------------------------------ | ------------- | ----------------------------- | ----------------------------- |
 * | 1 | disconnected, cleanup complete / not required, way up        | `gone`        | `disconnected`                | `connect_again` (person)      |
 * | 2 | disconnected, cleanup complete / not required, way down      | `gone`        | `disconnected`                | `connect_new` (person)        |
 * | 3 | disconnected, cleanup owed, access sync pending, way up      | `gone`        | `disconnect_finishing`        | `retry` (dorkos, retryAt)     |
 * | 4 | disconnected, cleanup owed, access sync pending, way not linked or not answering | `gone` | `disconnect_finishing` | `wait` (dorkos, retryAt) |
 * | 5 | disconnected, cleanup owed, way down: own key                | `gone`        | `disconnect_stuck`            | `fix_key` (person)            |
 * | 6 | disconnected, cleanup owed, way down: anything else          | `gone`        | `disconnect_stuck`            | none                          |
 * | 7 | disconnected, cleanup unknown, DorkOS account                | `gone`        | `disconnect_stuck`            | none                          |
 * | 8 | disconnected, cleanup owed, way up                           | `gone`        | `disconnect_failed`           | `retry` (person)              |
 * | 9 | turned off for this chat (agent views only)                  | `unavailable` | `off_for_this_chat`           | none                          |
 * | 10 | way down: DorkOS account not linked                         | `needs_you`   | `dorkos_account_unlinked`     | `connect_new` (person)        |
 * | 11 | way down: DorkOS account can't reach apps                   | `unavailable` | `dorkos_account_unavailable`  | `retry` (dorkos)              |
 * | 12 | way down: own key not set up or not answering               | `needs_you`   | `own_key_unavailable`         | `fix_key` (person)            |
 * | 13 | way down: nothing DorkOS can name                           | `unavailable` | `way_unreachable`             | none                          |
 * | 14 | way up but can't run actions, a key would fix it            | `needs_you`   | `own_key_cannot_run_actions`  | `fix_key` (person)            |
 * | 15 | way up but can't run actions, nothing would fix it          | `unavailable` | `cannot_run_actions`          | none                          |
 * | 16 | paused                                                      | `paused`      | `paused`                      | `resume` (person)             |
 * | 17 | sign-in expired or revoked                                  | `needs_you`   | `signed_out`                  | `sign_in_again` (person)      |
 * | 18 | sign-in pending                                             | `needs_you`   | `sign_in_unfinished`          | `sign_in_again` (person)      |
 * | 19 | needs review                                                | `needs_you`   | `needs_review`                | `review_access` (person)      |
 * | 20 | access sync failed                                          | `needs_you`   | `access_update_failed`        | `review_access` (person)      |
 * | 21 | access sync pending                                         | `finishing`   | `access_updating`             | `wait` (dorkos, retryAt)      |
 * | 22 | everything else                                             | `ready`       | `usable`                      | none                          |
 *
 * "Cleanup owed" is any external cleanup other than complete / not required.
 * Why the way comes before paused and signed out: while it is down, resuming or
 * signing in again cannot make the account usable, so those would be buttons
 * that can't work. Access sync is optional: an agent's own view leaves it out,
 * because the stored sync spans every agent's access on the account and
 * execution checks this agent's own scope.
 *
 * @module services/connectors/connection-readiness
 */
import {
  ConnectionReadinessSchema,
  type ConnectionFix,
  type ConnectionReadiness,
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
 */
export type ConnectionWayHealth =
  | { readonly status: 'up'; readonly canRunActions: true }
  | { readonly status: 'up'; readonly canRunActions: false; readonly keyCanFix: boolean }
  | { readonly status: 'down'; readonly problem: ConnectorWayProblem | 'unreachable' };

/** Reads the live health of the way behind one provider instance. */
export type ConnectionWayHealthPort = (providerInstanceId: string) => ConnectionWayHealth;

/**
 * The health of one way from its live route: down (with the fix `problem`
 * names, else `unreachable`) when nothing is registered, otherwise up and
 * whether agents can act through it. Only a Composio account key has a fix
 * for "can't run actions": a project key runs them. A self-hosted Nango
 * server never runs them, whatever its key.
 *
 * @param live - The registered route, if any.
 * @param problem - Why the way is down, when a known way is.
 */
export function wayHealthOf(
  live: ConnectorProvider | undefined,
  problem: () => ConnectorWayProblem | undefined
): ConnectionWayHealth {
  if (!live) return { status: 'down', problem: problem() ?? 'unreachable' };
  if (live.getCapabilities().capabilities.execution.status === 'available') {
    return { status: 'up', canRunActions: true };
  }
  return { status: 'up', canRunActions: false, keyCanFix: live.type === 'composio' };
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
  /** Account-wide access sync; omitted in an agent's own view. */
  readonly authoritySync?: ConnectorAuthoritySyncState;
  /** What is still owed at the service after a disconnect. */
  readonly externalCleanup?: 'not_required' | 'pending' | 'complete' | 'failed' | 'unknown';
  /** `managed` for an account connected through the DorkOS account. */
  readonly mode: 'managed' | 'byo';
  /** The live health of the way it was connected through. */
  readonly way: ConnectionWayHealth;
  /** True when this chat turned the account off for its agent. */
  readonly offForThisChat?: boolean;
}

/** One reason's words: for the owner, and for an agent. */
interface ReadinessCopy {
  readonly owner: string;
  readonly agent: string;
}

const ASK_ON_CONNECTIONS = 'on the Connections page in the DorkOS app';
const GONE_AGENT =
  'The person disconnected this account. Ask them to connect it again if you need it.';

/**
 * Every line readiness says, in one place. Owner lines sit under the app's
 * name, so they say 'it'. Agent lines say what the person must do.
 */
const COPY: Readonly<
  Record<Exclude<ConnectionReadinessReason, 'disconnect_stuck'>, ReadinessCopy>
> = {
  usable: {
    owner: 'Agents can use it.',
    agent: 'You can use this account.',
  },
  off_for_this_chat: {
    owner: 'Turned off for this chat.',
    agent:
      'The person turned this account off for this chat, so you can’t use it here. Don’t ask for it again in this chat.',
  },
  dorkos_account_unlinked: {
    owner:
      'It was connected through your DorkOS account, which isn’t linked anymore. Connect it again to use it.',
    agent:
      'It was connected through the person’s DorkOS account, which isn’t linked anymore. Ask the person to connect this app again ' +
      `${ASK_ON_CONNECTIONS}. Linking the account again doesn’t bring it back on its own.`,
  },
  dorkos_account_unavailable: {
    owner: 'Your DorkOS account can’t reach it right now. DorkOS will keep checking.',
    agent:
      'It was connected through the person’s DorkOS account, which can’t reach apps right now. Try again later. The person doesn’t need to do anything.',
  },
  own_key_unavailable: {
    owner: 'The key it was connected through isn’t set up or didn’t answer. Fix the key to use it.',
    agent:
      'It was connected through the person’s own key, which isn’t set up or didn’t answer when DorkOS last checked it. ' +
      'Ask the person to fix the key in Settings › Connections in the DorkOS app.',
  },
  way_unreachable: {
    owner: 'DorkOS can’t reach the service it was connected through, so agents can’t use it.',
    agent:
      'DorkOS can’t reach the service this account was connected through. Tell the person. Asking for access won’t help.',
  },
  own_key_cannot_run_actions: {
    owner:
      'Agents can’t use it: your key can sign in to apps but can’t run their actions. Change it to a project key.',
    agent:
      'The person’s own key can sign in to apps but can’t run their actions. Ask the person to change it to a project key in Settings › Connections in the DorkOS app.',
  },
  cannot_run_actions: {
    owner: 'Agents can’t use apps connected this way yet.',
    agent:
      'Agents can’t use apps connected the way this one was. Tell the person. Asking for access won’t help.',
  },
  paused: {
    owner: 'Paused. Agents can’t use it until you resume it.',
    agent: `The person paused this account. Ask them to resume it ${ASK_ON_CONNECTIONS}.`,
  },
  signed_out: {
    owner: 'Signed out. Agents can’t use it until you sign in again.',
    agent: `The sign-in for this account ended. Ask the person to sign in again ${ASK_ON_CONNECTIONS}.`,
  },
  sign_in_unfinished: {
    owner: 'Sign-in didn’t finish. Agents can’t use it until you sign in again.',
    agent: `The sign-in for this account didn’t finish. Ask the person to sign in again ${ASK_ON_CONNECTIONS}.`,
  },
  needs_review: {
    owner: 'Check who can use it. Agents can’t use it until you do.',
    agent: `The person needs to check who can use this account before agents can use it again. Ask them to check it ${ASK_ON_CONNECTIONS}.`,
  },
  access_update_failed: {
    owner: 'A change to who can use it didn’t go through. Check who can use it.',
    agent: `A change to who can use this account didn’t go through. Ask the person to check it ${ASK_ON_CONNECTIONS}.`,
  },
  access_updating: {
    owner: 'Updating who can use it…',
    agent:
      'DorkOS is still updating who can use this account. Try again in a few minutes. The person doesn’t need to do anything.',
  },
  disconnected: {
    owner: 'Disconnected. Agents can’t use it.',
    agent: GONE_AGENT,
  },
  disconnect_finishing: {
    owner: 'Disconnected. Agents can’t use it. DorkOS is still removing its access at the service.',
    agent: GONE_AGENT,
  },
  disconnect_failed: {
    owner:
      'Disconnected. Agents can’t use it. Removing its access at the service didn’t finish. Try again.',
    agent: GONE_AGENT,
  },
};

/**
 * The owner's line for a disconnect DorkOS can't finish right now, by why it
 * can't: the one thing the person can do, or where they can finish it
 * themselves.
 */
function stuckOwnerLine(cause: ConnectorWayProblem | 'unreachable' | 'unconfirmed'): string {
  const lead = 'Disconnected. Agents can’t use it.';
  const ownSettings = 'To be sure its access ended, remove it in that app’s own account settings.';
  switch (cause) {
    case 'own_key_unavailable':
      return `${lead} DorkOS can’t finish removing its access at the service until your key works again. Fix the key, then try again.`;
    case 'dorkos_account_unlinked':
      return `${lead} DorkOS can’t finish removing its access at the service, because your DorkOS account isn’t linked anymore. ${ownSettings}`;
    case 'unconfirmed':
      return `${lead} DorkOS couldn’t confirm its access ended at the service. ${ownSettings}`;
    case 'dorkos_account_unavailable':
    case 'unreachable':
      return `${lead} DorkOS can’t reach the service to finish removing its access. ${ownSettings}`;
  }
}

/** Build and check one readiness value. */
function readiness(
  state: ConnectionReadinessState,
  reason: ConnectionReadinessReason,
  fix?: ConnectionFix,
  owner?: string
): ConnectionReadiness {
  const words = reason === 'disconnect_stuck' ? undefined : COPY[reason];
  return ConnectionReadinessSchema.parse({
    state,
    reason,
    ...(fix && { fix }),
    copy: { owner: owner ?? words!.owner, agent: words?.agent ?? GONE_AGENT },
  });
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
    const retrying =
      wayUp || (way.status === 'down' && way.problem === 'dorkos_account_unavailable');
    if (retrying) {
      return readiness('gone', 'disconnect_finishing', {
        action: wayUp ? 'retry' : 'wait',
        fixableBy: 'dorkos',
        ...retryAtOf(facts.authoritySync),
      });
    }
  }
  if (way.status === 'down') {
    return way.problem === 'own_key_unavailable'
      ? readiness(
          'gone',
          'disconnect_stuck',
          { action: 'fix_key', fixableBy: 'person' },
          stuckOwnerLine(way.problem)
        )
      : readiness('gone', 'disconnect_stuck', undefined, stuckOwnerLine(way.problem));
  }
  // An account closed because a new DorkOS account link couldn't reach it:
  // disconnecting again goes to a link that doesn't know it, so it can't work.
  if (cleanup === 'unknown' && facts.mode === 'managed') {
    return readiness('gone', 'disconnect_stuck', undefined, stuckOwnerLine('unconfirmed'));
  }
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
  if (facts.offForThisChat) return readiness('unavailable', 'off_for_this_chat');
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
        });
      case 'own_key_unavailable':
        return readiness('needs_you', 'own_key_unavailable', {
          action: 'fix_key',
          fixableBy: 'person',
        });
      case 'unreachable':
        return readiness('unavailable', 'way_unreachable');
    }
  }
  if (!way.canRunActions) {
    return way.keyCanFix
      ? readiness('needs_you', 'own_key_cannot_run_actions', {
          action: 'fix_key',
          fixableBy: 'person',
        })
      : readiness('unavailable', 'cannot_run_actions');
  }
  if (facts.lifecycle === 'paused') {
    return readiness('paused', 'paused', { action: 'resume', fixableBy: 'person' });
  }
  if (facts.authenticationStatus === 'expired' || facts.authenticationStatus === 'revoked') {
    return readiness('needs_you', 'signed_out', { action: 'sign_in_again', fixableBy: 'person' });
  }
  if (facts.authenticationStatus === 'pending') {
    return readiness('needs_you', 'sign_in_unfinished', {
      action: 'sign_in_again',
      fixableBy: 'person',
    });
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
