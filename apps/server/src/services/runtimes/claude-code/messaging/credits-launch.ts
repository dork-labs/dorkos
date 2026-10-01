/**
 * The environment a Claude Code turn on DorkOS credits launches with (ADR
 * 261001-000811), built so the credits token can reach the credits endpoint
 * and nothing else, and so nothing but the credits token pays.
 *
 * Two layers, because Claude Code reads two:
 *
 * - **The process environment drops every name that routes or pays.** A credits
 *   turn carries the baseline names every child gets (paths, locale, proxies,
 *   certificates), DorkOS's own variables, the person's own inherit list minus
 *   anything that routes a turn or holds a credential, and the credits pair. No
 *   key, no OAuth token, no `CLAUDE_CODE_USE_*` routing switch and no cloud
 *   credential survives, whichever list carried it.
 * - **The flag-level settings pin the endpoint.** A project's or a folder's own
 *   `.claude/settings.json` / `settings.local.json` `env` OUTRANKS the process
 *   environment inside the CLI, so a folder could otherwise point
 *   `ANTHROPIC_BASE_URL` at its own server and receive the credits token as a
 *   bearer. The launch's own settings (`options.settings`, the CLI's
 *   `--settings`) outrank project settings, so the endpoint goes there, with a
 *   blank over every routing and credential variable Claude Code knows and over
 *   every such variable a folder's settings set. A folder that sets `PATH`, a
 *   proxy or a certificate variable gets the server's own value back instead,
 *   because a folder's proxy or certificate could read the token in flight.
 *   Every other variable a folder sets (a `DATABASE_URL`, a tool's home) is
 *   the folder's business and is left alone, so its hooks and commands work
 *   on credits exactly as on any other sign-in.
 *
 * The token itself never goes into settings: the SDK passes them on the command
 * line, where other users of the machine can read them. It stays in the process
 * environment. A folder whose settings name their own sign-in
 * (`ANTHROPIC_AUTH_TOKEN` or `apiKeyHelper`) would replace it with theirs and
 * send the person's own credential to the credits endpoint, so such a launch is
 * refused instead.
 *
 * Managed (policy) settings outrank even the launch's own; they are the
 * organisation's, and DorkOS does not override them.
 *
 * @module services/runtimes/claude-code/messaging/credits-launch
 */
import fs from 'node:fs';
import path from 'node:path';
import { BASELINE_ENV_NAMES } from '../../shared/runtime-environment-catalog.js';
import type { StreamEvent } from '@dorkos/shared/types';
import { CreditsUnavailableError } from '../../../core/cloud/credits-inference.js';
import type { AgentSession } from '../agent-types.js';
import { isCreditsClaudeRoot } from '../credits-root.js';

/** DorkOS's own variables a credits turn keeps, beside the baseline. */
const CREDITS_OWN_NAMES = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS',
  'CLAUDE_CODE_ENABLE_TODO_TOOLS',
  'DORKOS_AGENT_TOKEN',
  'MCP_TOOL_TIMEOUT',
  'DISABLE_TELEMETRY',
  'DISABLE_ERROR_REPORTING',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
] as const;

/** The git hardening every child's git gets (`withGitConfigEnv`). */
const GIT_CONFIG_NAME = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;

const ALLOWED = new Set<string>([...BASELINE_ENV_NAMES, ...CREDITS_OWN_NAMES]);

/**
 * Every routing switch, alternative endpoint and credential Claude Code reads
 * (read off the bundled binary's own lists), blanked in a credits turn's
 * settings so a folder's settings cannot turn any of them on.
 */
export const CREDITS_BLANKED_SETTINGS_NAMES = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_GOOGLE_CLOUD_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_AWS_API_KEY',
] as const;

const BLANKED = new Set<string>(CREDITS_BLANKED_SETTINGS_NAMES);

/**
 * The name families that route a turn or hold a credential: Anthropic's own
 * variables, Claude Code's routing and auth-skipping switches, and the cloud
 * credential families a routed turn could pay with. A future variable in one
 * of these families is covered without an edit here.
 */
const ROUTING_OR_PAYING_FAMILY =
  /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_SKIP_|CLAUDE_CODE_OAUTH|_CLAUDE_CODE_|AWS_|GOOGLE_|GCLOUD_|CLOUDSDK_|CLOUD_ML_|VERTEX_|AZURE_)/;

/**
 * Whether a variable routes a Claude Code turn or pays for one, so a credits
 * turn must never take it from anywhere but DorkOS.
 *
 * @param name - The variable's name.
 */
export function routesOrPays(name: string): boolean {
  return BLANKED.has(name) || ROUTING_OR_PAYING_FAMILY.test(name);
}

/**
 * Variables a folder's settings may not set on a credits turn and that cannot
 * simply be blanked: the server's own value is put back instead. `PATH` is
 * never blanked (hooks and commands need one); a proxy or certificate a folder
 * names could read the token in flight.
 */
export const CREDITS_REASSERTED_NAMES = [
  'PATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'NODE_TLS_REJECT_UNAUTHORIZED',
] as const;

const REASSERTED = new Set<string>(CREDITS_REASSERTED_NAMES);

/** The `PATH` a credits turn gets in the unlikely case its own environment has none. */
const FALLBACK_PATH = '/usr/bin:/bin';

/**
 * The process environment of a credits turn: the baseline, DorkOS's own
 * variables and the person's inherit list, minus every name that routes or
 * pays, with the credits pair on top.
 *
 * @param projected - The environment `runtimeEnvironment` built for the turn.
 * @param creditsEnv - The credits endpoint and token.
 * @param inherit - The person's own inherit list for Claude Code.
 */
export function creditsProcessEnv(
  projected: Readonly<Record<string, string>>,
  creditsEnv: Readonly<Record<string, string>>,
  inherit: readonly string[] = []
): Record<string, string> {
  const inherited = new Set(inherit.filter((name) => !routesOrPays(name)));
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(projected)) {
    const own = ALLOWED.has(name) || GIT_CONFIG_NAME.test(name) || inherited.has(name);
    if (own && !routesOrPays(name)) kept[name] = value;
  }
  return { ...kept, ...creditsEnv };
}

/** A folder's settings, as far as a credits turn cares. */
interface FolderSettings {
  env: Record<string, unknown>;
  apiKeyHelper: unknown;
}

/** Read one settings file, or nothing when it is absent or unreadable. */
function readSettingsFile(file: string): FolderSettings | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as { env?: unknown; apiKeyHelper?: unknown };
    const env =
      parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
        ? (parsed.env as Record<string, unknown>)
        : {};
    return { env, apiKeyHelper: parsed.apiKeyHelper };
  } catch {
    // A file the CLI cannot parse either sets nothing it would apply.
    return null;
  }
}

/** The git root above `dir`, if `dir` is inside a repository. */
function gitRootOf(dir: string): string | null {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The project and local settings files Claude Code can read for a turn in
 * `cwd`: the working directory's own `.claude/`, and its repository root's.
 *
 * @param cwd - The turn's working directory.
 */
export function folderSettingsFiles(cwd: string): string[] {
  const dirs = new Set([path.resolve(cwd)]);
  const root = gitRootOf(cwd);
  if (root) dirs.add(root);
  return [...dirs].flatMap((dir) => [
    path.join(dir, '.claude', 'settings.json'),
    path.join(dir, '.claude', 'settings.local.json'),
  ]);
}

/**
 * The flag-level settings `env` of a credits turn: the credits endpoint, a
 * blank over every routing or credential variable Claude Code knows and over
 * every such variable a folder's settings set, and the server's own value over
 * any `PATH`, proxy or certificate variable a folder's settings set. Every other
 * variable a folder sets is left to the folder.
 *
 * @param cwd - The turn's working directory.
 * @param baseUrl - The credits endpoint.
 * @param processEnv - The environment the turn's process gets: the source of
 *   the values put back over a folder's `PATH`, proxy and certificates.
 * @throws {CreditsUnavailableError} When a folder's settings name their own
 *   sign-in, which would replace the credits token with the person's own.
 */
export function creditsSettingsEnv(
  cwd: string,
  baseUrl: string,
  processEnv: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const blanks = new Set<string>(CREDITS_BLANKED_SETTINGS_NAMES);
  const reasserted = new Set<string>();
  for (const file of folderSettingsFiles(cwd)) {
    const settings = readSettingsFile(file);
    if (!settings) continue;
    const helper = settings.apiKeyHelper;
    const ownToken = settings.env.ANTHROPIC_AUTH_TOKEN;
    if ((typeof helper === 'string' && helper.trim() !== '') || typeof ownToken === 'string') {
      throw new CreditsUnavailableError('folder-sign-in', 'Claude Code');
    }
    for (const name of Object.keys(settings.env)) {
      if (REASSERTED.has(name)) reasserted.add(name);
      else if (routesOrPays(name)) blanks.add(name);
    }
  }
  blanks.delete('ANTHROPIC_BASE_URL');
  blanks.delete('ANTHROPIC_AUTH_TOKEN');
  const env: Record<string, string> = {};
  for (const name of [...blanks].sort()) env[name] = '';
  // Only what a folder set is put back, so a proxy's address (which can carry
  // its own password) reaches the command line only when a folder forced it.
  for (const name of [...reasserted].sort()) {
    const own = name === 'PATH' ? (processEnv.PATH ?? FALLBACK_PATH) : processEnv[name];
    env[name] = own ?? '';
  }
  env.ANTHROPIC_BASE_URL = baseUrl;
  return env;
}

/**
 * Whether a session runs on DorkOS credits: its launch (or its transcript) is
 * in the credits folder.
 *
 * @param session - The session.
 */
export function onCreditsSession(
  session: Pick<AgentSession, 'launchedAccountRoot' | 'accountRoot'>
): boolean {
  const root = session.launchedAccountRoot ?? session.accountRoot;
  return root !== undefined && isCreditsClaudeRoot(root);
}

/**
 * The event a credits turn ends with when its token was refused partway
 * through: the credits card's code and sentence, the vendor's own words kept
 * in `details`.
 *
 * @param details - What the backend said, if anything.
 */
export function creditsStoppedEvent(details?: string): StreamEvent {
  const refusal = new CreditsUnavailableError('stopped', 'Claude Code');
  return {
    type: 'error',
    data: {
      message: refusal.message,
      code: refusal.code,
      category: 'execution_error',
      ...(details ? { details } : {}),
    },
  };
}

/**
 * A credits turn's sign-in failure, said as what it is. Every other event is
 * passed through untouched.
 *
 * @param event - One event of a credits turn.
 */
export function asCreditsStopped(event: StreamEvent): StreamEvent {
  if (event.type !== 'error') return event;
  const data = event.data as { category?: string; message?: string; details?: string };
  if (data.category !== 'auth_error') return event;
  return creditsStoppedEvent(data.details ?? data.message);
}
