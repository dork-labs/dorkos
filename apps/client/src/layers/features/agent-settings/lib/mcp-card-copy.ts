import type { ManagedMcpServerView, McpServerTransport } from '@dorkos/shared/mesh-schemas';
import type { McpCardStatus } from './mcp-server-state';

/**
 * How loudly a card presents itself. `attention` and `error` earn a colored left
 * edge; everything else is calm. Nothing is carried by color alone — the chip
 * always says the state in words too.
 */
export type McpCardTone = 'calm' | 'attention' | 'error';

/** What a status looks and reads like on a card. */
interface McpStatusMeta {
  /** The chip label a person reads at a glance. */
  label: string;
  /** The fuller sentence the chip's tooltip expands to. */
  tooltip: string;
  /** How loud the card is; drives the left edge. */
  tone: McpCardTone;
}

/**
 * Presentation for every card state.
 *
 * Typed as a total record so adding a state to {@link McpCardStatus} fails the
 * build here rather than silently rendering nothing.
 */
export const MCP_STATUS_META: Record<McpCardStatus, McpStatusMeta> = {
  'needs-sign-in': {
    label: 'Needs sign-in',
    tooltip: 'Sign in to let this agent use the server.',
    tone: 'attention',
  },
  'signing-in': {
    label: 'Signing in…',
    tooltip: 'A sign-in is in progress. Finish it in the tab that opened.',
    tone: 'attention',
  },
  connected: {
    label: 'Connected',
    tooltip: 'This server answered, and its tools are available to the agent.',
    tone: 'calm',
  },
  'signed-in': {
    label: 'Signed in',
    tooltip: 'DorkOS has a sign-in for this server. Use Test to check it responds.',
    tone: 'calm',
  },
  'uses-your-key': {
    label: 'Uses your key',
    tooltip: 'This server is authenticated with a key you supplied, not one DorkOS holds.',
    tone: 'calm',
  },
  'cant-reach': {
    label: 'Can’t reach',
    tooltip: 'The server did not answer. Open Details for what it said.',
    tone: 'error',
  },
  'setup-problem': {
    label: 'Setup problem',
    tooltip: 'This server’s setup is wrong, so it could not start. Open Details for the reason.',
    tone: 'error',
  },
  connecting: {
    label: 'Connecting…',
    tooltip: 'The agent is connecting to this server.',
    tone: 'calm',
  },
  'not-checked': {
    label: 'Not checked yet',
    tooltip: 'Nothing has contacted this server yet, so there is nothing to report.',
    tone: 'calm',
  },
  off: {
    label: 'Off',
    tooltip: 'Turned off. Its tools are not given to the agent.',
    tone: 'calm',
  },
};

/** The one action a card leads with, or `none` when there is nothing to do. */
type McpPrimaryAction = 'sign-in' | 'try-again' | 'test' | 'none';

/** Which action each state leads with. */
const PRIMARY_ACTION: Record<McpCardStatus, McpPrimaryAction> = {
  'needs-sign-in': 'sign-in',
  'signing-in': 'none',
  connected: 'none',
  'signed-in': 'test',
  'uses-your-key': 'test',
  'cant-reach': 'try-again',
  'setup-problem': 'try-again',
  connecting: 'none',
  'not-checked': 'test',
  off: 'none',
};

/**
 * The single action a card in this state leads with.
 *
 * @param status - The card's state.
 */
export function primaryActionFor(status: McpCardStatus): McpPrimaryAction {
  return PRIMARY_ACTION[status];
}

/** What a card's one sentence needs to know beyond its state. */
export interface McpSentenceContext {
  /** The server's readable name, for the sign-in sentence. */
  displayName: string;
  /** Tools the server is known to expose, or `null` when unknown. */
  toolCount: number | null;
  /** Whether the sign-in that produced this state just happened on screen. */
  justSignedIn: boolean;
}

/**
 * The connected sentence.
 *
 * The tool count is the payoff — the difference between "something happened" and
 * "you can now do N things" — but it is not always known, so the sentence
 * degrades to what is still true rather than claiming "0 tools".
 */
function connectedSentence({ toolCount, justSignedIn }: McpSentenceContext): string {
  const prefix = justSignedIn ? 'Signed in just now. ' : '';
  if (toolCount === null) return `${prefix || 'This server answered. '}Its tools are available.`;
  return `${prefix}${toolCount} tool${toolCount === 1 ? '' : 's'} available.`;
}

/**
 * The one plain sentence a card shows under its name: what is happening, and
 * what to do about it.
 *
 * `signing-in` returns `null` — the sign-in surface below the card is carrying
 * the whole story at that moment, and a second sentence above it would only
 * compete with the consent copy.
 *
 * @param status - The card's state.
 * @param context - What the sentence needs beyond the state.
 */
export function cardSentence(status: McpCardStatus, context: McpSentenceContext): string | null {
  switch (status) {
    case 'needs-sign-in':
      return `Sign in to ${context.displayName} so this agent can use its tools.`;
    case 'signing-in':
      return null;
    case 'connected':
      return connectedSentence(context);
    case 'signed-in':
      // A sign-in that just happened on screen gets its moment, but not a claim
      // it has not earned: holding a token is not the same as having reached the
      // server, and Test is still the thing that would prove it.
      return context.justSignedIn
        ? 'Signed in just now. Test to check the server responds.'
        : 'DorkOS has a sign-in for this server. Test to check it responds.';
    case 'uses-your-key':
      return 'You added an access key when setting this up.';
    case 'cant-reach':
      return 'This server didn’t answer. It may be down.';
    case 'setup-problem':
      return 'This server’s setup has a problem.';
    case 'connecting':
      return 'Connecting to this server.';
    case 'not-checked':
      return 'Nothing has checked this server yet.';
    case 'off':
      return 'Turned off. The agent doesn’t see this server.';
  }
}

/**
 * What the Details "Sign-in" row says about how a server authenticates.
 *
 * The signed-in DATE is deliberately absent: it is not on the wire yet
 * (DOR-1006), and a sentence that invented one would be the kind of confident
 * lie this redesign exists to remove.
 *
 * @param args.connection - The managed server's connection.
 * @param args.authStatus - The listing's derived sign-in state, if any.
 * @param args.clientOrigin - Which OAuth client identity DorkOS holds, when it
 *   holds one (DOR-982). Only `'manual'` changes the sentence: automatic
 *   registration is the ordinary case and naming it would be noise.
 */
export function signInRowCopy(args: {
  connection: McpServerTransport;
  authStatus: ManagedMcpServerView['authStatus'];
  clientOrigin?: ManagedMcpServerView['authClientOrigin'];
}): string {
  const { connection, authStatus, clientOrigin } = args;
  if (connection.transport === 'stdio') return 'None. This server doesn’t need one.';
  if (connection.authKind === 'oauth2') {
    if (clientOrigin === 'manual') {
      const held =
        authStatus === 'connected' ? 'signed in, and it renews automatically' : 'not signed in yet';
      return `OAuth: using your own app credentials, ${held}. DorkOS holds the key; the agent never sees it.`;
    }
    if (authStatus === 'connected') {
      return 'OAuth: signed in, and it renews automatically. DorkOS holds the key; the agent never sees it.';
    }
    return 'OAuth: DorkOS will hold the key for you; the agent never sees it.';
  }
  const hasOwnHeader = Object.keys(connection.headers).some(
    (header) => header.toLowerCase() === 'authorization'
  );
  if (hasOwnHeader) return 'Access key: you added a key when setting this up.';
  if (authStatus === undefined) return 'Nothing has checked this yet.';
  return 'None. This server doesn’t need one.';
}

/**
 * What the Details "Source" row says about where a server actually lives: the
 * host for a remote one, the command for a local one.
 *
 * @param connection - The managed server's connection.
 */
export function sourceRowCopy(connection: McpServerTransport): string {
  if (connection.transport === 'stdio') {
    return `Runs \`${connection.command}\` on this computer`;
  }
  const host = hostOf(connection.url);
  return host ? `${host} (web service)` : `${connection.url} (web service)`;
}

/**
 * The host of a URL, or `null` when it will not parse. Used for the Source row,
 * which names a server's home in the form a person recognises.
 *
 * @param url - The server's URL.
 */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
