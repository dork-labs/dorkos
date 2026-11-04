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
import {
  isSecretName,
  isUnpinnedPackage,
  runnerPackageSpec,
} from '@dorkos/shared/global-mcp-schemas';
import type { McpServerTransport } from '@dorkos/shared/mesh-schemas';

import { flaggedEnvNames } from '../services/mesh/global-mcp/global-mcp-guard.js';
import { maskedArgs, maskUrls } from '../services/mesh/global-mcp/global-mcp-mask.js';

/** The longest name, package or command line a sheet shows before cutting it. */
const MAX_SHOWN = 400;

/** The longest agent name a sentence shows; agents pick what they're called. */
const MAX_AGENT_NAME = 40;

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
      ? (runnerPackageSpec(connection.command, connection.args) ?? connection.command)
      : new URL(connection.url).origin;
  return `${shown(server.name)} (${shown(maskedArgs([what])[0]!)})`;
}

/** Who gets the server, as the sentence ends. */
function scope(excludedAgents: readonly string[]): string {
  const left = excludedAgents.length;
  if (left === 0) return 'for all your agents';
  return `for all your agents except ${left === 1 ? 'one' : left}`;
}

/** What a held change does, for its sentence. */
export type ServerChange = 'add' | 'change' | 'turn-on' | 'let-more';

/** What an agent is called, from the server's records. */
export interface AgentNames {
  /** Its registered name. Only a person can change it. */
  name: string;
  /** What it calls itself on screen. An agent can set this to anything. */
  displayName?: string;
}

/** One agent name as a sentence shows it: plain text, cut short. */
function shownAgent(name: string): string {
  const flat = shown(name);
  return flat.length > MAX_AGENT_NAME ? `${flat.slice(0, MAX_AGENT_NAME - 1)}…` : flat;
}

/**
 * What the sheet calls an agent. An agent picks its own display name, so when that says something
 * other than the registered name, the registered name goes beside it: an agent can't pass as
 * another one on a sheet a person is confirming.
 *
 * @param agent - The agent's names.
 */
export function agentLabel({ name, displayName }: AgentNames): string {
  const shownName = shownAgent(name);
  const display = displayName === undefined ? '' : shownAgent(displayName);
  if (display === '') return shownName;
  return display.toLowerCase() === name.toLowerCase() ? display : `${display} (${shownName})`;
}

/**
 * Who gets a server, as the sheet's last line.
 *
 * @param server - The server as it will be.
 * @param added - The labels of the agents this change adds, an unknown one as `undefined`; none
 *   when it turns the server on.
 */
export function whoGetsIt(server: ServerForStepUp, added: readonly (string | undefined)[]): string {
  if (added.length > 0) {
    const [only] = added;
    if (added.length > 1) return `${added.length} more agents get it.`;
    return only ? `${only} gets it too.` : 'One more agent gets it.';
  }
  const left = server.excludedAgents.length;
  if (left === 0) return 'All your agents get it.';
  return `All your agents get it, except ${left === 1 ? 'one' : left}.`;
}

/**
 * The sentence for letting more agents use a server that is already on. What
 * runs is not changing, so it names the server; the notes still show the command.
 *
 * @param server - The server as it will be.
 * @param added - The labels of the agents it adds, an unknown one as `undefined`.
 */
function letMoreReason(server: ServerForStepUp, added: readonly (string | undefined)[]): string {
  const name = shown(server.name);
  if (server.excludedAgents.length === 0) return `Give ${name} to all your agents.`;
  const [only] = added;
  if (added.length === 1) return `Let ${only ?? 'one more agent'} use ${name}.`;
  return `Let ${added.length} more agents use ${name}.`;
}

/**
 * The sheet's sentence, which the audit log keeps too. No argument but the
 * package a runner runs, and for a remote server, its origin.
 *
 * @param change - What the held change does.
 * @param server - The server as it will be.
 * @param added - For `let-more`, the labels of the agents it adds.
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
      return `Add ${named} ${everyone}.`;
    case 'change':
      return `Change ${named} ${everyone}.`;
    case 'turn-on':
      return `Turn on ${named} ${everyone}.`;
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
 * The sheet's lines to look at twice, in warning ink. They are words first, so colour is never
 * the only signal.
 *
 * @param server - The server as it will be.
 */
export function serverWarnings(server: ServerForStepUp): string[] {
  const { connection, secretNames } = server;
  const warnings: string[] = [];
  if (connection.transport !== 'stdio' && crossesInTheClear(connection.url)) {
    const secrets = Object.keys(connection.headers).filter((name) =>
      isSecretName(name, secretNames)
    );
    if (secrets.length > 0) {
      warnings.push(
        `This address isn’t encrypted, so ${shown(secrets.join(', '))} travels in the clear.`
      );
    }
  }
  warnings.push(...flaggedEnvNames(connection).map((flag) => shown(flag.note)));
  return warnings;
}

/**
 * The sheet's lines: the whole of what runs, masked, and every name once, under either its plain
 * heading or "Kept secret". A person sees every setting and header they're agreeing to.
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
    notes.push(`Connects to: ${shown(maskUrls(connection.url))}`);
  }
  const names = Object.keys(valuesOf(connection));
  const secrets = names.filter((name) => isSecretName(name, secretNames));
  const plain = names.filter((name) => !secrets.includes(name));
  if (plain.length > 0) {
    const label = connection.transport === 'stdio' ? 'Settings' : 'Headers';
    notes.push(`${label}: ${shown(plain.join(', '))}`);
  }
  if (secrets.length > 0) notes.push(`Kept secret: ${shown(secrets.join(', '))}`);
  if (retyped && secrets.length > 0) notes.push(`New values for: ${shown(secrets.join(', '))}`);
  if (connection.transport === 'stdio' && isUnpinnedPackage(connection.command, connection.args)) {
    notes.push('Not pinned to a version. What runs can change later.');
  }
  notes.push(...serverWarnings(server));
  return notes;
}
