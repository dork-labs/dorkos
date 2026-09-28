/**
 * The Connections page as one list of apps (design record `connections-one-list`
 * §1, §2, §9): which rows sit in "Yours", what state each one is in, what the
 * one next thing to do is, and which apps "All apps" still offers.
 *
 * Pure: every function here takes the server's own answers and returns rows,
 * so the page never decides health on its own. A row is only ever `ready` when
 * every server-reported fact about it says an agent can use it now.
 *
 * @module features/connections/lib/app-list
 */
import type {
  ConnectorCatalogCategory,
  ConnectorCatalogService,
  ConnectorConnectionSummary,
} from '@dorkos/shared/connector-resource-schemas';
import { serviceNameFromToolkit } from '@dorkos/shared/connector-schemas';
import { serviceLogo, type ServiceLogo } from '@/layers/entities/connectors';
import type { AdapterBinding, CatalogEntry, CatalogInstance } from '@dorkos/shared/relay-schemas';

/**
 * How a row reads at a glance.
 *
 * - `ready` — agents can use it now (the only state with a green dot).
 * - `broken` — it stopped working and needs the person (amber, floats up).
 * - `attention` — it works, but something waits on the person.
 * - `busy` — something is in progress (signing in, updating access).
 * - `off` — paused or disconnected on purpose (greyed).
 */
export type AppRowTone = 'ready' | 'broken' | 'attention' | 'busy' | 'off';

/** The one thing a row offers on its right side, if anything. */
export type AppRowAction = 'sign-in-again' | 'resume' | 'cancel' | 'review' | 'fix';

/** One row in "Yours". */
export interface YourAppRow {
  /** The connection id, chat app id, or sign-in flow id. Unique across the list. */
  id: string;
  /** An app account, a chat app, or a sign-in still in progress. */
  kind: 'account' | 'chat' | 'connecting';
  /** The app's name, e.g. "Gmail". A second account is a second row with the same name. */
  name: string;
  /** Icon key for the app's `ServiceMark`. */
  iconKey: string;
  /** What the catalog says about the app's logo (`ServiceLogo`). */
  logo?: ServiceLogo;
  /**
   * Which account or bot it is: the name the person gave it ("work"), else its
   * address ("you@gmail.com"), else the bot's name ("@lifeos_bot").
   */
  account: string | null;
  /** The account's address when the row goes by a name, shown beside it in the panel. */
  identity: string | null;
  /** The plain line under the name: which account, who can use it, or what is wrong. */
  detail: string;
  /** How the row reads. */
  tone: AppRowTone;
  /** The one action on the row's right side. */
  action: AppRowAction | null;
  /** People waiting for someone to answer them (chat apps only). */
  waiting: number;
  /** A chat app DorkOS no longer offers; set-up ones keep working. */
  deprecated?: boolean;
}

/** A sign-in that has started and not finished, shown as a "Connecting" row. */
export interface PendingSignIn {
  /** The durable flow id. */
  flowId: string;
  /** The app's service id. */
  toolkit: string;
}

/** Everything {@link buildYourApps} reads. */
export interface YourAppsInput {
  /** Every connection the owner can see. */
  connections: readonly ConnectorConnectionSummary[];
  /** The chat app catalog (each entry's manifest and its set-up instances). */
  chatApps: readonly CatalogEntry[];
  /** Every chat binding (who answers which chat app). */
  bindings: readonly AdapterBinding[];
  /** Pending chats waiting for an answer, by chat app id. */
  waitingByChatApp: Readonly<Record<string, number>>;
  /** Agent display names by id. */
  agentNames: Readonly<Record<string, string>>;
  /** Catalog services by id, for names and sign-in companies. */
  services: ReadonlyMap<string, ConnectorCatalogService>;
  /** A sign-in in progress, when there is one. */
  pendingSignIn?: PendingSignIn | null;
}

/**
 * The name an account's row goes by: the catalog's name for the app.
 *
 * @param toolkit - The connection's service id.
 * @param services - Catalog services by id.
 */
export function accountAppName(
  toolkit: string,
  services: ReadonlyMap<string, ConnectorCatalogService>
): string {
  return services.get(toolkit)?.displayName ?? serviceNameFromToolkit(toolkit);
}

/** "No agents yet", "1 agent", "3 agents". */
function agentCountLine(count: number): string {
  if (count === 0) return 'No agents yet';
  return count === 1 ? '1 agent' : `${count} agents`;
}

/** "DorkBot", "DorkBot and mailroom", "DorkBot and 2 more". */
export function namesLine(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} more`;
}

/**
 * What an account is called. An account nobody named carries its app's id as
 * its label ("gmail"), which says nothing, so its address stands in; a name the
 * person chose always wins, with the address kept for the panel.
 *
 * @param connection - The connection summary.
 */
export function accountNames(connection: ConnectorConnectionSummary): {
  account: string;
  identity: string | null;
} {
  const named = connection.label.toLowerCase() !== connection.toolkit.toLowerCase();
  if (!named) return { account: connection.identityHint ?? connection.label, identity: null };
  const identity =
    connection.identityHint && connection.identityHint !== connection.label
      ? connection.identityHint
      : null;
  return { account: connection.label, identity };
}

/** What the catalog says about the app's logo, as a row field. */
function logoOf(
  toolkit: string,
  services: ReadonlyMap<string, ConnectorCatalogService>
): { logo?: ServiceLogo } {
  const logo = serviceLogo(services.get(toolkit));
  return logo === undefined ? {} : { logo };
}

/**
 * One account's row, decided from the server's own facts about it. Order
 * matters: the first fact that stops agents wins, so a signed-out account
 * never reads as merely "updating".
 *
 * @param connection - The connection summary.
 * @param services - Catalog services by id.
 */
export function accountRow(
  connection: ConnectorConnectionSummary,
  services: ReadonlyMap<string, ConnectorCatalogService>
): YourAppRow {
  const base = {
    id: connection.connectionId,
    kind: 'account' as const,
    name: accountAppName(connection.toolkit, services),
    iconKey: connection.toolkit,
    ...logoOf(connection.toolkit, services),
    ...accountNames(connection),
    waiting: 0,
  };
  const who = base.account;
  if (connection.lifecycle === 'disconnected') {
    return {
      ...base,
      tone: 'off',
      action: null,
      detail: `${who} · Disconnected. Agents can’t use it.`,
    };
  }
  if (connection.lifecycle === 'paused') {
    return { ...base, tone: 'off', action: 'resume', detail: `${who} · Paused` };
  }
  if (
    connection.authenticationStatus === 'expired' ||
    connection.authenticationStatus === 'revoked'
  ) {
    return {
      ...base,
      tone: 'broken',
      action: 'sign-in-again',
      detail: 'Signed out. Agents can’t use it until you sign in again.',
    };
  }
  if (connection.authenticationStatus === 'pending') {
    return {
      ...base,
      tone: 'broken',
      action: 'sign-in-again',
      detail: 'Sign-in didn’t finish. Agents can’t use it yet.',
    };
  }
  if (connection.authoritySync.status === 'failed') {
    return {
      ...base,
      tone: 'broken',
      action: 'review',
      detail: 'Couldn’t update who can use it. Check it again.',
    };
  }
  // The server marks a connection for review only when access someone holds
  // may have gone stale; until it says ready again, the row never reads green.
  if (connection.reconciliationStatus !== 'ready') {
    return {
      ...base,
      tone: 'attention',
      action: 'review',
      detail: 'Some of its actions changed. Check who can use it.',
    };
  }
  if (connection.authoritySync.status === 'pending') {
    return { ...base, tone: 'busy', action: null, detail: `${who} · Updating who can use it…` };
  }
  return {
    ...base,
    tone: 'ready',
    action: null,
    detail: `${who} · ${connection.everyAgent ? 'Every agent' : agentCountLine(connection.agentCount)}`,
  };
}

/**
 * Which bot a chat app row is: the label the person gave it, or the name the
 * platform reported when that says more than the app's own name.
 *
 * @param entry - The chat app's catalog entry.
 * @param instance - The set-up instance.
 */
export function chatAppAccount(entry: CatalogEntry, instance: CatalogInstance): string | null {
  if (instance.label) return instance.label;
  const reported = instance.status.displayName;
  return reported && reported !== entry.manifest.displayName ? reported : null;
}

/**
 * One chat app's row: its bot, who answers it, and anyone waiting.
 *
 * @param entry - The chat app's catalog entry.
 * @param instance - The set-up instance this row is for.
 * @param input - Bindings, agent names and waiting counts.
 */
export function chatAppRow(
  entry: CatalogEntry,
  instance: CatalogInstance,
  input: Pick<YourAppsInput, 'bindings' | 'agentNames' | 'waitingByChatApp'>
): YourAppRow {
  const manifest = entry.manifest;
  const botName = chatAppAccount(entry, instance);
  const base = {
    id: instance.id,
    kind: 'chat' as const,
    name: manifest.displayName,
    iconKey: manifest.iconId ?? manifest.type,
    account: botName,
    identity: null,
    waiting: input.waitingByChatApp[instance.id] ?? 0,
    deprecated: manifest.deprecated === true,
  };
  const withBot = (line: string) => (botName ? `${botName} · ${line}` : line);

  if (!instance.enabled) {
    return { ...base, tone: 'off', action: 'resume', detail: 'Paused · no messages in or out' };
  }
  if (instance.status.state === 'error' || instance.status.state === 'disconnected') {
    return {
      ...base,
      tone: 'broken',
      action: 'fix',
      detail: 'Stopped working. Messages aren’t getting through.',
    };
  }
  if (instance.status.state !== 'connected') {
    return { ...base, tone: 'busy', action: null, detail: withBot('Connecting…') };
  }
  const answerers = [
    ...new Set(
      input.bindings
        .filter((binding) => binding.adapterId === instance.id)
        .map((binding) => input.agentNames[binding.agentId] ?? binding.agentId)
    ),
  ];
  if (answerers.length === 0) {
    return { ...base, tone: 'attention', action: null, detail: withBot('No agent answers yet') };
  }
  const verb = answerers.length === 1 ? 'answers' : 'answer';
  return {
    ...base,
    tone: 'ready',
    action: null,
    detail: withBot(`${namesLine(answerers)} ${verb}`),
  };
}

/**
 * Where a row sits in "Yours": broken first, then what waits on you, then
 * everything working (busy and ready share a place, so a row never jumps while
 * it updates), then paused and disconnected. A sign-in in progress is not
 * sorted here; it always leads (see {@link buildYourApps}).
 */
const TONE_ORDER: Record<AppRowTone, number> = {
  broken: 1,
  attention: 2,
  busy: 3,
  ready: 3,
  off: 4,
};

/**
 * True for the built-in relay that carries agent-to-agent messages. It is how
 * DorkOS works inside, not something a person connects (§9 rule 4).
 *
 * @param entry - A chat app catalog entry.
 */
export function isPlumbing(entry: CatalogEntry): boolean {
  return entry.manifest.category === 'internal';
}

/**
 * Every row in "Yours": one per account (a second Gmail is a second row), one
 * per chat app set up, and a "Connecting" row while a sign-in is open.
 * Broken rows float to the top; paused and disconnected rows sink.
 *
 * @param input - The server's answers, see {@link YourAppsInput}.
 */
export function buildYourApps(input: YourAppsInput): YourAppRow[] {
  const rows: YourAppRow[] = input.connections.map((connection) =>
    accountRow(connection, input.services)
  );
  for (const entry of input.chatApps) {
    if (isPlumbing(entry)) continue;
    for (const instance of entry.instances) rows.push(chatAppRow(entry, instance, input));
  }
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .sort(
      (left, right) =>
        TONE_ORDER[left.row.tone] - TONE_ORDER[right.row.tone] ||
        left.row.name.localeCompare(right.row.name) ||
        left.index - right.index
    )
    .map(({ row }) => row);

  const pending = input.pendingSignIn;
  if (!pending) return ordered;
  const service = input.services.get(pending.toolkit);
  const name = service?.displayName ?? serviceNameFromToolkit(pending.toolkit);
  return [
    {
      id: pending.flowId,
      kind: 'connecting',
      name,
      iconKey: pending.toolkit,
      ...logoOf(pending.toolkit, input.services),
      account: null,
      identity: null,
      detail: `Waiting for you to finish signing in on ${service?.signInName ?? name}…`,
      tone: 'busy',
      action: 'cancel',
      waiting: 0,
    },
    ...ordered,
  ];
}

/** The ways an app can be used, and whether each one is already set up. */
export interface AppUses {
  /** Agents can act on the person's account in it. */
  account: boolean;
  /** People can talk to agents through it; the chat app's type when so. */
  chatType: string | null;
}

/**
 * What an app in the catalog can be used for.
 *
 * @param service - A catalog service.
 */
export function appUses(service: ConnectorCatalogService): AppUses {
  const chat = service.intents.find((intent) => intent.kind === 'messages');
  return {
    account: service.intents.some((intent) => intent.kind === 'account'),
    chatType: chat?.kind === 'messages' ? chat.relayAdapterType : null,
  };
}

/** What the person already has, for deciding what "All apps" still offers. */
export interface OwnedApps {
  /** Service ids with at least one live (not disconnected) account. */
  accounts: ReadonlySet<string>;
  /** Chat app types with at least one setup. */
  chatApps: ReadonlySet<string>;
}

/**
 * Collect what the person already has.
 *
 * @param connections - Every connection.
 * @param chatApps - The chat app catalog.
 */
export function ownedApps(
  connections: readonly ConnectorConnectionSummary[],
  chatApps: readonly CatalogEntry[]
): OwnedApps {
  return {
    accounts: new Set(
      connections
        .filter((connection) => connection.lifecycle !== 'disconnected')
        .map((connection) => connection.toolkit)
    ),
    chatApps: new Set(
      chatApps.filter((entry) => entry.instances.length > 0).map((entry) => entry.manifest.type)
    ),
  };
}

/**
 * The uses of an app the person hasn't set up yet. An app with none left is
 * already in "Yours" and leaves "All apps"; a second account or a second bot
 * is added from its side panel, the way a second Gmail becomes a second row.
 *
 * @param service - A catalog service.
 * @param owned - What the person already has.
 */
export function remainingUses(service: ConnectorCatalogService, owned: OwnedApps): AppUses {
  const uses = appUses(service);
  return {
    account: uses.account && !owned.accounts.has(service.serviceSlug),
    chatType: uses.chatType && !owned.chatApps.has(uses.chatType) ? uses.chatType : null,
  };
}

/** A shelf chip in "All apps". */
export type AppShelf = 'popular' | Exclude<ConnectorCatalogCategory, 'developer'> | 'all';

/** Plain names for the shelves, in the order the chips show. */
export const SHELF_LABELS: Record<AppShelf, string> = {
  popular: 'Popular',
  email: 'Email',
  calendar: 'Calendar',
  chat: 'Chat',
  docs: 'Docs',
  files: 'Files',
  code: 'Code',
  tasks: 'Tasks',
  sales: 'Sales',
  all: 'All',
};

/**
 * The chips worth showing: Popular, each shelf that has an app on it, and All.
 * A shelf with nothing on it draws no chip.
 *
 * @param services - The apps "All apps" offers.
 */
export function shelvesFor(services: readonly ConnectorCatalogService[]): AppShelf[] {
  const present = new Set(services.map((service) => service.category));
  const categories = (Object.keys(SHELF_LABELS) as AppShelf[]).filter(
    (shelf) => shelf !== 'popular' && shelf !== 'all' && present.has(shelf)
  );
  return ['popular', ...categories, 'all'];
}

/**
 * The apps on one shelf. "For developers" apps are never on a shelf; they sit
 * in their own small group under the list.
 *
 * @param services - The apps "All apps" offers.
 * @param shelf - The chosen chip.
 */
export function appsOnShelf(
  services: readonly ConnectorCatalogService[],
  shelf: AppShelf
): ConnectorCatalogService[] {
  const general = services.filter((service) => service.category !== 'developer');
  if (shelf === 'all') return general;
  if (shelf === 'popular') return general.filter((service) => service.popular);
  return general.filter((service) => service.category === shelf);
}

/**
 * True when a row's name or detail contains the search words.
 *
 * @param row - A "Yours" row.
 * @param query - What the person typed.
 */
export function rowMatches(row: YourAppRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return `${row.name} ${row.detail}`.toLowerCase().includes(needle);
}
