/**
 * What "Confirm it's you" says and binds for a global MCP server (DOR-3234,
 * DOR-3213): built here from what the server was sent, never from a sentence
 * the app wrote.
 *
 * Three outputs, three audiences, and a secret value reaches none of them:
 *
 * - **The bound input** ({@link boundServerInput}) is an allow-list: what runs,
 *   the names of its env vars and headers, and the values that are not secret.
 *   A secret is bound by name. What runs on confirm is fixed by the held action
 *   itself, so its hash does not need the value.
 * - **The reason** ({@link serverReason}) goes to the audit log as well as the
 *   sheet, and agents can read that log. So it names the server, its package or
 *   program and who gets it, and leaves every other argument out: arguments can
 *   carry secrets (`postgres://user:pass@…`, `--token=…`).
 * - **The notes** ({@link serverNotes}) go to the sheet only. They show the whole
 *   command with what looks secret masked, and env and header names without
 *   their values.
 *
 * @module routes/mcp-server-step-up
 */
import { isSecretName, SECRET_NAME_PATTERN } from '@dorkos/shared/global-mcp-schemas';
import type { McpServerTransport } from '@dorkos/shared/mesh-schemas';

import { flaggedEnvNames } from '../services/mesh/global-mcp/global-mcp-guard.js';

/** What stands in for a value on the sheet. */
const MASK = '•••';

/** The longest name, package or command line a sheet shows before cutting it. */
const MAX_SHOWN = 400;

/** The longest agent name a sentence shows; agents pick their own. */
const MAX_AGENT_NAME = 40;

/** Programs that fetch and run the package named in their arguments. */
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'uvx']);

/** Flags that change nothing about which package a runner runs. */
const QUIET_RUNNER_FLAGS = new Set(['-y', '--yes', '-q', '--quiet']);

/** A package spec with an exact version: `name@1.2.3`, `@scope/name@1.2.3`, `name==1.2.3`. */
const PINNED_SPEC = /(?:.@|==)\d[^/\s]*$/;

/** The part of a global server the sheet and the hash read. */
export interface ServerForStepUp {
  name: string;
  connection: McpServerTransport;
  secretNames: readonly string[];
  excludedAgents: readonly string[];
  enabled: boolean;
}

/** One line of text as a sheet shows it: no control characters, cut short. */
function shown(text: string): string {
  const flat = text
    .replace(/\p{C}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > MAX_SHOWN ? `${flat.slice(0, MAX_SHOWN - 1)}…` : flat;
}

/** The env map of a stdio server, or the header map of a remote one. */
function valuesOf(connection: McpServerTransport): Record<string, string> {
  return connection.transport === 'stdio' ? connection.env : connection.headers;
}

/**
 * The package a runner will run, or `undefined`. Any flag beyond the quiet ones
 * can change what really runs (`npx --package=other name`), so then it names
 * nothing rather than something that might not be true.
 */
function packageSpecOf(connection: McpServerTransport): string | undefined {
  if (connection.transport !== 'stdio' || !PACKAGE_RUNNERS.has(connection.command))
    return undefined;
  const first = connection.args.findIndex((arg) => !QUIET_RUNNER_FLAGS.has(arg));
  const spec = connection.args[first];
  return spec === undefined || spec.startsWith('-') ? undefined : spec;
}

/** Whether a stdio server runs a package whose version could change later. */
function isUnpinned(connection: McpServerTransport): boolean {
  if (connection.transport !== 'stdio' || !PACKAGE_RUNNERS.has(connection.command)) return false;
  const spec = packageSpecOf(connection);
  return spec === undefined || !PINNED_SPEC.test(spec);
}

/** Credentials and query strings out of any URL inside a string. */
function maskUrls(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, `$1${MASK}@`)
    .replace(/(:\/\/[^\s?#]*)[?#]\S*/g, `$1?${MASK}`);
}

/** Arguments with secret-named flags' values and URL credentials masked. */
function maskedArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let hideNext = false;
  for (const arg of args) {
    if (hideNext) {
      out.push(MASK);
      hideNext = false;
      continue;
    }
    const flag = /^(--?[^=\s]+)(=?)/.exec(arg);
    if (flag && SECRET_NAME_PATTERN.test(flag[1]!)) {
      if (flag[2] === '=') out.push(`${flag[1]}=${MASK}`);
      else {
        out.push(arg);
        hideNext = true;
      }
      continue;
    }
    out.push(maskUrls(arg));
  }
  return out;
}

/**
 * What to bind a held action to: everything that decides what runs, with every
 * secret value left out.
 *
 * @param op - What the action does.
 * @param server - The server, as sent or as stored.
 */
export function boundServerInput(op: string, server: ServerForStepUp): unknown {
  const { connection, secretNames } = server;
  const names = Object.keys(valuesOf(connection)).sort();
  const plain = Object.fromEntries(
    names
      .filter((name) => !isSecretName(name, secretNames))
      .map((name) => [name, valuesOf(connection)[name]!])
  );
  const secret = names.filter((name) => isSecretName(name, secretNames));
  return {
    op,
    name: server.name,
    enabled: server.enabled,
    excludedAgents: [...server.excludedAgents],
    secretNames: [...secretNames],
    secret,
    plain,
    ...(connection.transport === 'stdio'
      ? { transport: 'stdio', command: connection.command, args: [...connection.args] }
      : {
          transport: connection.transport,
          url: connection.url,
          authKind: connection.authKind ?? null,
        }),
  };
}

/** The server and what it runs, for the sheet's one sentence. */
function subject(server: ServerForStepUp): string {
  const { connection } = server;
  const what =
    connection.transport === 'stdio'
      ? (packageSpecOf(connection) ?? connection.command)
      : new URL(connection.url).origin;
  return `${shown(server.name)} (\`${shown(maskUrls(what))}\`)`;
}

/** Who gets the server, as the sentence ends. */
function scope(excludedAgents: readonly string[]): string {
  const left = excludedAgents.length;
  if (left === 0) return 'for all your agents';
  return `for all your agents except ${left === 1 ? 'one' : left}`;
}

/** What a held change does, for its sentence. */
export type ServerChange = 'add' | 'change' | 'turn-on' | 'let-more';

/** An agent's name, from the server's records, as a sentence shows it. */
function shownAgent(name: string): string {
  const flat = shown(name);
  return flat.length > MAX_AGENT_NAME ? `${flat.slice(0, MAX_AGENT_NAME - 1)}…` : flat;
}

/**
 * Who gets a server, as the sheet's last line.
 *
 * @param server - The server as it will be.
 * @param added - How many agents this change adds; `0` when it turns the server on.
 */
export function whoGetsIt(server: ServerForStepUp, added: number): string {
  if (added > 0) return added === 1 ? 'One more agent gets it.' : `${added} more agents get it.`;
  const left = server.excludedAgents.length;
  if (left === 0) return 'All your agents get it.';
  return `All your agents get it, except ${left === 1 ? 'one' : left}.`;
}

/**
 * The sentence for letting more agents use a server that is already on. What
 * runs is not changing, so it names the server; the notes still show the command.
 *
 * @param server - The server as it will be.
 * @param added - The names of the agents it adds, an unknown one as `undefined`.
 */
function letMoreReason(server: ServerForStepUp, added: readonly (string | undefined)[]): string {
  const name = shown(server.name);
  if (server.excludedAgents.length === 0)
    return `Confirm it’s you to give ${name} to all your agents.`;
  const [only] = added;
  if (added.length === 1) {
    return `Confirm it’s you to let ${only ? shownAgent(only) : 'one more agent'} use ${name}.`;
  }
  return `Confirm it’s you to let ${added.length} more agents use ${name}.`;
}

/**
 * The sheet's sentence, which the audit log keeps too. No argument but the
 * package a runner runs, and for a remote server, its origin.
 *
 * @param change - What the held change does.
 * @param server - The server as it will be.
 * @param added - For `let-more`, the names of the agents it adds.
 */
export function serverReason(
  change: ServerChange,
  server: ServerForStepUp,
  added: readonly (string | undefined)[] = []
): string {
  const named = subject(server);
  const everyone = scope(server.excludedAgents);
  switch (change) {
    case 'add':
      return `Confirm it’s you to add ${named} ${everyone}.`;
    case 'change':
      return `Confirm it’s you to change ${named} ${everyone}.`;
    case 'turn-on':
      return `Confirm it’s you to turn on ${named} ${everyone}.`;
    case 'let-more':
      return letMoreReason(server, added);
  }
}

/** Whether a URL is plain `http` to anywhere but this computer. */
function crossesInTheClear(raw: string): boolean {
  const url = new URL(raw);
  if (url.protocol !== 'http:') return false;
  return !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/**
 * The sheet's quiet lines: the whole of what runs, masked, and names only.
 *
 * @param server - The server as it will be.
 * @param retyped - Whether a person just typed its secrets again.
 */
export function serverNotes(server: ServerForStepUp, retyped = false): string[] {
  const { connection, secretNames } = server;
  const notes: string[] = [];
  if (connection.transport === 'stdio') {
    notes.push(`Runs: ${shown([connection.command, ...maskedArgs(connection.args)].join(' '))}`);
  } else {
    const url = new URL(connection.url);
    const hidden = url.search || url.hash ? `?${MASK}` : '';
    notes.push(`Connects to: ${shown(`${url.origin}${url.pathname}${hidden}`)}`);
  }
  const names = Object.keys(valuesOf(connection));
  if (names.length > 0) {
    const label = connection.transport === 'stdio' ? 'Settings' : 'Headers';
    notes.push(`${label}: ${shown(names.join(', '))}`);
  }
  const secrets = names.filter((name) => isSecretName(name, secretNames));
  if (secrets.length > 0) notes.push(`Kept secret: ${shown(secrets.join(', '))}`);
  if (retyped && secrets.length > 0) notes.push(`New values for: ${shown(secrets.join(', '))}`);
  if (connection.transport !== 'stdio' && secrets.length > 0 && crossesInTheClear(connection.url)) {
    notes.push(
      `This address isn’t encrypted, so ${shown(secrets.join(', '))} travels in the clear.`
    );
  }
  if (isUnpinned(connection)) notes.push('Not pinned to a version. What runs can change later.');
  notes.push(...flaggedEnvNames(connection).map((flag) => shown(flag.note)));
  return notes;
}
