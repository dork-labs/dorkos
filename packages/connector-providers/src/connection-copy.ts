/**
 * The words every connector surface shows: readiness lines, labels, and the
 * plain names of the ways DorkOS reaches apps. Re-exported from
 * `connector-schemas`, so callers import them from there.
 *
 * @module connector-providers/connection-copy
 */
import type {
  ConnectionReadinessReason,
  ConnectorOperationClassification,
} from './connector-schemas.js';

/** One readiness reason's words: for the owner, and for an agent. */
export interface ConnectionReadinessCopy {
  readonly owner: string;
  readonly agent: string;
}

const READINESS_ASK_ON_CONNECTIONS = 'on the Connections page in the DorkOS app';
/** What an agent reads about an account the person disconnected. */
export const CONNECTION_GONE_AGENT_COPY =
  'The person disconnected this account. Ask them to connect it again if you need it.';

/**
 * Every line readiness says, in one place: the server's readiness function is
 * its one reader (tests read it too, so a mock never copies a string). Owner
 * lines sit under the app's name, so they say "it". Agent lines say what the
 * person must do.
 */
export const CONNECTION_READINESS_COPY: Readonly<
  Record<Exclude<ConnectionReadinessReason, 'disconnect_stuck'>, ConnectionReadinessCopy>
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
  // Linking this computer again with the same DorkOS account can continue its
  // earlier link, and so bring the account back (DOR-2521); never promised.
  dorkos_account_unlinked: {
    owner:
      'It was connected through your DorkOS account, which isn’t linked anymore. Linking this computer again with the same ' +
      'DorkOS account can bring it back, unless its earlier link was removed from that account. Otherwise, connect it again.',
    agent:
      'It was connected through the person’s DorkOS account, which isn’t linked anymore. Linking this computer again with the ' +
      'same DorkOS account (Settings › DorkOS account in the DorkOS app) can bring it back, unless its earlier link was removed from ' +
      'that account. A different account, or a link made on another computer, does not bring it back: then ask the person to ' +
      `connect this app again ${READINESS_ASK_ON_CONNECTIONS}.`,
  },
  dorkos_account_unavailable: {
    owner: 'Your DorkOS account can’t reach it right now, so agents can’t use it.',
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
      'DorkOS can’t reach the service this account was connected through. Asking for access won’t help.',
  },
  own_key_cannot_run_actions: {
    owner:
      'Agents can’t use it: your key can sign in to apps but can’t run their actions. Change it to a project key.',
    agent:
      'The person’s own key can sign in to apps but can’t run their actions. Ask the person to change it to a project key in Settings › Connections in the DorkOS app.',
  },
  cannot_run_actions: {
    owner: 'Agents can’t use apps connected this way yet.',
    agent: 'Agents can’t use apps connected the way this one was. Asking for access won’t help.',
  },
  paused: {
    owner: 'Paused. Agents can’t use it until you resume it.',
    agent: `The person paused this account. Ask them to resume it ${READINESS_ASK_ON_CONNECTIONS}.`,
  },
  signing_in: {
    owner: 'Finish signing in again. Agents can’t use it until you do.',
    agent: `The person is signing in to this account again. Ask them to finish signing in ${READINESS_ASK_ON_CONNECTIONS}.`,
  },
  signed_out: {
    owner: 'Signed out. Agents can’t use it until you sign in again.',
    agent: `The sign-in for this account ended. Ask the person to sign in again ${READINESS_ASK_ON_CONNECTIONS}.`,
  },
  sign_in_unfinished: {
    owner: 'Sign-in didn’t finish. Agents can’t use it until you sign in again.',
    agent: `The sign-in for this account didn’t finish. Ask the person to sign in again ${READINESS_ASK_ON_CONNECTIONS}.`,
  },
  needs_review: {
    owner:
      'How DorkOS reaches it changed, so check who can use it. Agents can’t use it until you do.',
    agent: `How DorkOS reaches this account changed, so the person needs to confirm who can use it before agents can use it again. Ask them to check it ${READINESS_ASK_ON_CONNECTIONS}.`,
  },
  access_update_failed: {
    owner: 'A change to who can use it didn’t go through. Check who can use it.',
    agent: `A change to who can use this account didn’t go through. Ask the person to check it ${READINESS_ASK_ON_CONNECTIONS}.`,
  },
  access_updating: {
    owner: 'Updating who can use it…',
    agent:
      'DorkOS is still updating who can use this account. Try again in a few minutes. The person doesn’t need to do anything.',
  },
  disconnected: {
    owner: 'Disconnected. Agents can’t use it.',
    agent: CONNECTION_GONE_AGENT_COPY,
  },
  disconnect_finishing: {
    owner: 'Disconnected. Agents can’t use it. DorkOS is still removing its access at the service.',
    agent: CONNECTION_GONE_AGENT_COPY,
  },
  gone_at_service: {
    owner:
      'Your DorkOS account no longer has this connection, so agents can’t use it. Connect it again to use it. To be sure its old access ended, remove it in that app’s own account settings.',
    agent:
      'The person’s DorkOS account no longer has this connection. Ask the person to connect it again if you need it.',
  },
};

/** Why DorkOS can't finish removing a disconnected account's access at the service. */
export type ConnectionDisconnectStuckCause =
  | 'own_key_unavailable'
  | 'dorkos_account_unlinked'
  | 'dorkos_account_unavailable'
  | 'unreachable'
  | 'unconfirmed';

/**
 * The owner's line for a disconnect DorkOS can't finish right now, by why it
 * can't: the one thing the person can do, or where they can finish it
 * themselves.
 *
 * @param cause - Why it can't finish.
 */
export function disconnectStuckOwnerLine(cause: ConnectionDisconnectStuckCause): string {
  const lead = 'Disconnected. Agents can’t use it.';
  const ownSettings = 'To be sure its access ended, remove it in that app’s own account settings.';
  switch (cause) {
    case 'own_key_unavailable':
      return `${lead} DorkOS can’t finish removing its access at the service until the key it was connected through works again. Add that same key again and DorkOS finishes it on its own.`;
    case 'dorkos_account_unlinked':
      return `${lead} DorkOS can’t finish removing its access at the service, because your DorkOS account isn’t linked anymore. Link this computer to the same DorkOS account again and DorkOS finishes it on its own. ${ownSettings}`;
    case 'unconfirmed':
      return `${lead} DorkOS couldn’t confirm its access ended at the service. ${ownSettings}`;
    case 'dorkos_account_unavailable':
    case 'unreachable':
      return `${lead} DorkOS can’t reach the service to finish removing its access. ${ownSettings}`;
  }
}

/**
 * The words for an account whose own key didn't answer for a reason that may
 * pass (a timeout, an outage): DorkOS checks it again on its own.
 */
export const WAY_RECHECK_COPY: ConnectionReadinessCopy = {
  owner: 'The key it was connected through didn’t answer. DorkOS checks it again on its own.',
  agent:
    'The way this account was connected through didn’t answer. DorkOS checks it again on its own, so try again in a few minutes. The person doesn’t need to do anything.',
};

/**
 * The words for an account whose way DorkOS is checking right now, or will
 * check again on its own before long: nothing for anyone to press yet.
 */
export const WAY_CHECKING_COPY: ConnectionReadinessCopy = {
  owner: 'DorkOS is checking how it reaches it. This takes a moment.',
  agent:
    'DorkOS is checking how it reaches this account. Try again in a few minutes. The person doesn’t need to do anything.',
};

/**
 * Pages where a person can end an app's access to their account themselves,
 * by the account's service. Only pages known to hold that setting are listed;
 * an app missing here gets the plain line with no link.
 */
const SERVICE_ACCESS_PAGES: Readonly<Record<string, { service: string; url: string }>> = {
  google: { service: 'Google', url: 'https://myaccount.google.com/connections' },
  github: { service: 'GitHub', url: 'https://github.com/settings/applications' },
  dropbox: { service: 'Dropbox', url: 'https://www.dropbox.com/account/connected_apps' },
};

/** Which account service each app signs in through, for the apps whose page is known. */
const SERVICE_OF_APP: Readonly<Record<string, keyof typeof SERVICE_ACCESS_PAGES>> = {
  gmail: 'google',
  googlecalendar: 'google',
  googledocs: 'google',
  googlesheets: 'google',
  googledrive: 'google',
  github: 'github',
  dropbox: 'dropbox',
};

/**
 * Where the person can end DorkOS's access to one app's account themselves,
 * when that page is known.
 *
 * @param toolkit - The app's slug, e.g. `'gmail'`.
 */
export function serviceAccessPageFor(
  toolkit: string
): { readonly service: string; readonly url: string } | undefined {
  const service = SERVICE_OF_APP[toolkit];
  return service === undefined ? undefined : SERVICE_ACCESS_PAGES[service];
}

/**
 * What an agent is told to do about an account nothing fixes from here: tell
 * the person. Added only when no concrete fix sentence follows.
 */
export const TELL_THE_PERSON_AGENT_COPY = 'Tell the person.';

/**
 * The words added when an account connected a way that can't be used offers
 * connecting it again, because another way works.
 */
export const CONNECT_ANOTHER_WAY_COPY: ConnectionReadinessCopy = {
  owner: 'Connect it again another way to use it.',
  agent:
    'Ask the person to connect it again another way on the Connections page in the DorkOS app.',
};

/**
 * The words added when the owner can turn an app back on for one chat. The
 * agent line is unchanged: an agent never reads the owner's chat view, and it
 * should not ask for an app the person turned off.
 */
export const TURN_ON_FOR_THIS_CHAT_COPY: Partial<ConnectionReadinessCopy> = {
  owner: 'Turn it on to let this agent use it here again.',
};

/**
 * Why a way can't do something at all, in the words a person or agent reads
 * wherever the way's abilities are shown (the connect dialog, the access
 * review, an agent's tool result). Each way's code states its limits with
 * these lines, never its own.
 */
export const WAY_CAPABILITY_COPY = {
  /** The way signs in to apps but can't run their actions. */
  cannotRunActions: 'Agents can’t use apps connected this way yet.',
  /** The way can't say which actions an app offers. */
  cannotListActions: 'DorkOS can’t list what an app can do when it’s connected this way.',
  /** The way can't deliver notifications from apps. */
  noNotifications: 'Notifications aren’t available for apps connected this way.',
  /** A person's own Composio key is an account key, which can't run actions. */
  accountKeyCannotRunActions:
    'This key can sign in to apps but can’t run their actions. Change it to a project key from your Composio dashboard.',
} as const;

/**
 * Why a waiting approval or request was cancelled because the access behind
 * it ended. A person reads it on the approval or request; an agent reads it
 * as the answer to what it was waiting for.
 */
export const ACCESS_ENDED_COPY = {
  /** The account was disconnected. */
  connection_removed: 'The account was disconnected, so this was cancelled.',
  /** The agent was removed. */
  agent_removed: 'The agent was removed, so this was cancelled.',
  /** The agent's access to the account was taken away. */
  agent_connection_removed:
    'The agent’s access to this account was removed, so this was cancelled.',
} as const;

/**
 * What a person reads under one of their own keys when DorkOS's last check of
 * it failed. The service's own error text goes to the log, never here.
 */
export const KEY_CHECK_COPY = {
  /** The service turned the key down (it answered 401 or 403). */
  refused: 'The service turned this key down. Check it’s the right key, then save it again.',
  /** The check failed a way that can pass, and DorkOS has a re-check scheduled. */
  checkingAgain: 'DorkOS couldn’t check this key just now. It checks again on its own.',
  /** The check failed and DorkOS has stopped checking on its own. */
  stoppedChecking:
    'DorkOS couldn’t check this key and has stopped trying on its own. Save it again to check it now.',
  /**
   * Nothing answered at the service's address (a name that doesn't resolve, a
   * refused connection, a 404 on the base address).
   *
   * @param type - The way's type: `'nango'` names the person's own server.
   * @param recheckScheduled - Whether DorkOS will check it again on its own.
   */
  unreachable(type: string, recheckScheduled: boolean): string {
    const lead =
      type === 'nango'
        ? 'DorkOS couldn’t reach your Nango server.'
        : 'DorkOS couldn’t reach Composio.';
    if (recheckScheduled) return `${lead} It checks again on its own.`;
    return type === 'nango'
      ? `${lead} Check that it’s running and its address is right, then save the key again.`
      : `${lead} Check your internet connection, then save the key again.`;
  },
} as const;

/**
 * What a person reads when a change to who can use an account can't be sent
 * because this computer's DorkOS account link is gone.
 */
export const LINK_NEEDED_TO_CHANGE_ACCESS_COPY =
  'DorkOS can’t change who uses this account until this computer is linked to your DorkOS account again. Link it in Settings › DorkOS account, then try again.';

/**
 * What a person reads when a sign-in can't start or doesn't finish. The
 * server's sign-in flow is the one writer; the connect dialog shows the line.
 */
export const SIGN_IN_COPY = {
  /** The way changed, or stopped answering, while the person was signing in. */
  wayChanged:
    'The way DorkOS reaches this app changed or stopped working while you were signing in. Start again.',
  /** The way isn't set up, or isn't working, so a sign-in can't start. */
  wayUnavailable:
    'The way DorkOS reaches this app isn’t set up or isn’t working right now. Check it in Settings › Connections, then try again.',
  /** The service said the sign-in didn't finish. */
  failed: 'Sign-in didn’t finish. Try again.',
  /** The service that handles sign-in isn't set up to connect this app. */
  serviceNotReady: 'This app can’t be connected yet. This isn’t something you can fix here.',
  /** The service's sign-in setup for this app failed its own safety check. */
  setupNeedsFix:
    'This app’s sign-in setup in DorkOS has a problem. Trying again won’t help until it’s fixed.',
  /** This computer has to be linked to its DorkOS account before sign-in can start. */
  accountLinkRequired: 'Link this computer to your DorkOS account, then connect again.',
  /** The service hit a brief, transient failure trying to start sign-in. */
  serviceUnavailable: 'Nothing was connected. Try again in a few minutes.',
} as const;

/** The service behind each way, by the way's type: what its key or server is called. */
const SERVICE_NAMES: Readonly<Record<string, string>> = {
  'dorkos-managed': 'DorkOS',
  composio: 'Composio',
  nango: 'Nango',
  mcp: 'MCP',
  'test-connector': 'Test connector',
};

/**
 * How a person knows each way DorkOS reaches apps, by the way's type. Every
 * surface that names a way (Settings › Connections, "How it's connected", the
 * connect dialog, the catalog's warnings, an agent's recommendation) reads it
 * from here, and the server works it out from the stored type when it reads a
 * way, so a stored raw name never reaches anyone.
 */
const WAY_NAMES: Readonly<Record<string, string>> = {
  'dorkos-managed': 'Your DorkOS account',
  composio: 'Your Composio key',
  nango: 'Your Nango server',
  // Raw MCP talks straight to the app's own server, never one the person runs.
  mcp: 'The app’s own MCP server',
  'test-connector': 'Your test key',
};

/** "Composio" from `composio`; an unknown type is title-cased. */
function titleCase(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * The name of the service behind a way, for a key's own label ("Composio
 * project key", "Nango API key"). An unknown type is title-cased.
 *
 * @param type - The way's type, e.g. `'composio'`.
 */
export function connectionServiceName(type: string): string {
  return SERVICE_NAMES[type] ?? titleCase(type);
}

/**
 * The plain name of one way DorkOS reaches apps. An unknown type is named as
 * one of the person's own keys rather than shown as a raw slug.
 *
 * @param type - The way's type, e.g. `'composio'` or `'dorkos-managed'`.
 */
export function connectionWayName(type: string): string {
  return WAY_NAMES[type] ?? `Your ${titleCase(type)} key`;
}

/**
 * The one line about who pays for an app's use, or `null` when nobody bills
 * for it: a self-hosted Nango server or an MCP server is the person's own, so
 * there is no bill to name. Only the DorkOS-account way and a person's own
 * Composio key have one.
 *
 * @param route - The way's payer and where its sign-ins are kept.
 */
export function connectionUsageLine(route: {
  readonly payer: 'operator_byo' | 'dorkos_managed';
  readonly custody: 'managed' | 'self-host' | 'external';
}): string | null {
  if (route.payer === 'dorkos_managed') return 'Your DorkOS account covers its use.';
  // Composio keeps the sign-in (managed custody) on a person's own key.
  if (route.custody === 'managed') return 'Any usage charges go to your own Composio account.';
  return null;
}

/**
 * Plain words for what one app action can do, shown in place of its stored
 * class. `destructive` is "High risk", never "Delete": the service marks
 * sending, sharing, forwarding and actions it hasn't sorted as destructive
 * too, so all the words can promise is that it needs more care.
 */
export const OPERATION_CLASSIFICATION_LABELS: Readonly<
  Record<ConnectorOperationClassification, string>
> = {
  read: 'Read',
  write: 'Write',
  destructive: 'High risk',
};

/**
 * What a set of action kinds lets an agent do, in words: `read`,
 * `read and write`, `read, write and high-risk actions`. Never "delete": the
 * service marks sending and sharing destructive too. The app and the server's
 * Activity entries both read it here.
 *
 * @param classifications - The kinds of the granted actions.
 */
export function connectionAccessWords(
  classifications: readonly ConnectorOperationClassification[]
): string {
  const words = (['read', 'write', 'destructive'] as const)
    .filter((kind) => classifications.includes(kind))
    .map((kind) => (kind === 'destructive' ? 'high-risk actions' : kind));
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** Plain words for a connected account's sign-in state, shown in place of its stored value. */
export const CONNECTION_STATUS_LABELS: Readonly<
  Record<'active' | 'expired' | 'revoked' | 'pending' | 'paused', string>
> = {
  active: 'Connected',
  expired: 'Signed out',
  revoked: 'Disconnected',
  pending: 'Signing in',
  paused: 'Paused',
};
