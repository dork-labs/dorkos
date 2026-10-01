/**
 * The environment a Claude Code turn on DorkOS credits launches with (ADR
 * 261001-000811), built so the credits token can reach the credits endpoint
 * and nothing else, and so nothing but the credits token pays.
 *
 * Two layers, because Claude Code reads two:
 *
 * - **The process environment is an allowlist.** A credits turn carries the
 *   baseline names every child gets (paths, locale, proxies, certificates),
 *   DorkOS's own variables, and the credits pair. Nothing else from the server's
 *   environment survives: no key, no OAuth token, no `CLAUDE_CODE_USE_*`
 *   routing switch, no cloud credential, and not the person's own inherit list,
 *   whatever names it holds.
 * - **The flag-level settings pin the endpoint.** A project's or a folder's own
 *   `.claude/settings.json` / `settings.local.json` `env` OUTRANKS the process
 *   environment inside the CLI, so a folder could otherwise point
 *   `ANTHROPIC_BASE_URL` at its own server and receive the credits token as a
 *   bearer. The launch's own settings (`options.settings`, the CLI's
 *   `--settings`) outrank project settings, so the endpoint goes there, with a
 *   blank over every routing and credential variable Claude Code knows and over
 *   every variable a folder's settings set that is not on a short safe list.
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
 * The process environment of a credits turn: the projected environment kept
 * to the allowlist, with the credits pair on top.
 *
 * @param projected - The environment `runtimeEnvironment` built for the turn.
 * @param creditsEnv - The credits endpoint and token.
 */
export function creditsProcessEnv(
  projected: Readonly<Record<string, string>>,
  creditsEnv: Readonly<Record<string, string>>
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(projected)) {
    if (ALLOWED.has(name) || GIT_CONFIG_NAME.test(name)) kept[name] = value;
  }
  return { ...kept, ...creditsEnv };
}

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

/**
 * Variables a folder's settings may set on a credits turn and keep: limits and
 * switches that change how the CLI behaves, never where a turn goes or who
 * pays. Every other variable a folder's settings set is blanked.
 */
const SAFE_FOLDER_SETTINGS_NAMES = new Set<string>([
  'MAX_THINKING_TOKENS',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'BASH_DEFAULT_TIMEOUT_MS',
  'BASH_MAX_TIMEOUT_MS',
  'BASH_MAX_OUTPUT_LENGTH',
  'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR',
  'MCP_TIMEOUT',
  'MCP_TOOL_TIMEOUT',
  'MAX_MCP_OUTPUT_TOKENS',
  'DISABLE_TELEMETRY',
  'DISABLE_ERROR_REPORTING',
  'DISABLE_AUTOUPDATER',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
]);

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
 * The flag-level settings `env` of a credits turn: the credits endpoint, and a
 * blank over every routing or credential variable and every variable a
 * folder's settings set that is not on the safe list.
 *
 * @param cwd - The turn's working directory.
 * @param baseUrl - The credits endpoint.
 * @throws {CreditsUnavailableError} When a folder's settings name their own
 *   sign-in, which would replace the credits token with the person's own.
 */
export function creditsSettingsEnv(cwd: string, baseUrl: string): Record<string, string> {
  const blanks = new Set<string>(CREDITS_BLANKED_SETTINGS_NAMES);
  for (const file of folderSettingsFiles(cwd)) {
    const settings = readSettingsFile(file);
    if (!settings) continue;
    const helper = settings.apiKeyHelper;
    const ownToken = settings.env.ANTHROPIC_AUTH_TOKEN;
    if ((typeof helper === 'string' && helper.trim() !== '') || typeof ownToken === 'string') {
      throw new CreditsUnavailableError('folder-sign-in', 'Claude Code');
    }
    for (const name of Object.keys(settings.env)) {
      if (!SAFE_FOLDER_SETTINGS_NAMES.has(name)) blanks.add(name);
    }
  }
  blanks.delete('ANTHROPIC_BASE_URL');
  blanks.delete('ANTHROPIC_AUTH_TOKEN');
  const env: Record<string, string> = {};
  for (const name of [...blanks].sort()) env[name] = '';
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
