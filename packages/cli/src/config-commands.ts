import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { execFileSync } from 'child_process';
import path from 'path';
// Types only — erased before the bundle, and resolved for tsc by the
// declaration mirror in `packages/cli/server/`.
import type { GuardedConfigWriteResult } from '../server/services/core/operator/config-write.js';

/**
 * The refusal code the Full-autonomy consent door answers with, as a literal.
 *
 * It cannot be imported: the constant lives in the server bundle, which this
 * file only reaches through a specifier esbuild rewrites at bundle time, and a
 * value import would have to be awaited inside the refusal path. So it is
 * duplicated here — the same way the cockpit duplicates it (`ChatStatusSection`)
 * — and pinned by value in
 * `apps/server/src/services/core/approvals/__tests__/autonomy-consent.test.ts`,
 * which names both copies.
 */
const AUTONOMY_ACK_REQUIRED_CODE = 'AUTONOMY_ACK_REQUIRED';

/** The command that gives the terminal the acknowledgement the door asks for. */
const ACKNOWLEDGE_AUTONOMY_COMMAND = 'dorkos config acknowledge-autonomy';

/**
 * Minimal interface for config operations needed by CLI commands.
 *
 * Decouples CLI logic from ConfigManager implementation for testability.
 */
export interface ConfigStore {
  getAll(): UserConfig;
  getDot(key: string): unknown;
  setDot(key: string, value: unknown): { warning?: string };
  reset(key?: string): void;
  /**
   * Whether the config DorkOS is running on satisfies the schema.
   *
   * `warnings` names settings whose stored value this build cannot read — a
   * newer build widened them, so DorkOS is running on the default and has left
   * the value in the file (DOR-1227). Those are reported, never fatal: they are
   * version skew, not damage.
   */
  validate(): { valid: boolean; errors?: string[]; warnings?: string[] };
  readonly path: string;
}

/**
 * How `dorkos config` reaches the server's config-write code.
 *
 * A seam, not indirection for its own sake: the two functions below live in the
 * server bundle, which the CLI reaches through a specifier that only resolves
 * once esbuild has rewritten it (`packages/cli/server/**.d.ts` explains the
 * arrangement). A test running from source cannot resolve it at all, so the
 * dependency is passed in and {@link createServerConfigWriter} builds the
 * production one.
 */
export interface CliConfigWriter {
  /**
   * Write through the same guarded step `PATCH /api/config` uses: the write
   * policy, the Full-autonomy consent door, and the audit line.
   *
   * @param patch - The partial config to merge.
   * @param source - How this write should read in the audit line.
   */
  guarded(patch: Record<string, unknown>, source: string): Promise<GuardedConfigWriteResult>;
}

/**
 * Point the server's logger at this data directory, so the write about to happen
 * leaves its line in the same `~/.dork/logs/dorkos.log` the server writes to.
 *
 * ## Best-effort, and only on a WRITE (DOR-1247)
 *
 * Both halves are load-bearing, and both are fixes for one defect found in
 * review.
 *
 * **Only on a write.** This used to run for every `dorkos config` subcommand,
 * from inside `openConfigStore`. `initLogger` calls `mkdirSync(logDir)`, so
 * `dorkos config get` — the command somebody runs BECAUSE their install is
 * broken — died with a raw `EACCES` stack on any data directory it could not
 * write to, which is the normal shape of a root-owned `~/.dork` volume in the
 * Docker deployment. A pure read also has no business creating a `logs/`
 * directory as a side effect.
 *
 * **Best-effort.** A log DorkOS cannot open must never be the reason a setting
 * cannot be changed. A failure here degrades to one plain warning and the write
 * goes ahead unrecorded — worse than being recorded, far better than refusing a
 * person their own settings.
 *
 * @param dorkHome - The resolved data directory.
 * @param level - The operator's own `logging.level`, already a number.
 */
async function openAuditLog(dorkHome: string, level: number): Promise<void> {
  const logDir = path.join(dorkHome, 'logs');
  try {
    const { initLogger } = await import('../server/lib/logger.js');
    initLogger({ logDir, level });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `⚠  Could not open the log at ${logDir}, so this change will not be recorded there: ${reason}`
    );
  }
}

/**
 * The production writer: the server's own guarded step, under the operator's own
 * identity.
 *
 * `LOCAL_OPERATOR_AUTHORITY` carries the reasoning for that identity — briefly,
 * a person at their own terminal is the same trust the cockpit has in the
 * default posture, and the consent door still applies to them.
 *
 * The specifier is written out in full rather than held in a constant. A dynamic
 * import whose specifier is a VARIABLE is invisible to every mechanism that keeps
 * this working — esbuild cannot rewrite it, tsc cannot resolve it, and
 * `__tests__/server-shims.test.ts` cannot see it — so it would survive the build
 * and only fail at a user's install.
 *
 * @param dorkHome - The resolved data directory, for the audit log.
 * @param logLevel - The operator's own `logging.level` as a number.
 * @returns The writer to hand {@link handleConfigCommand}.
 */
export function createServerConfigWriter(dorkHome: string, logLevel: number): CliConfigWriter {
  return {
    async guarded(patch, source) {
      await openAuditLog(dorkHome, logLevel);
      const { applyGuardedConfigWrite, LOCAL_OPERATOR_AUTHORITY } =
        await import('../server/services/core/operator/config-write.js');
      return applyGuardedConfigWrite({ patch, authority: LOCAL_OPERATOR_AUTHORITY, source });
    },
  };
}

/**
 * Parse a CLI string value into the appropriate JavaScript type.
 *
 * @param value - Raw string from command line
 * @returns Parsed value (boolean, number, null, or string)
 */
export function parseConfigValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') return num;
  return value;
}

/**
 * Flatten nested config object into dot-path entries.
 *
 * @param obj - Config object to flatten
 * @param prefix - Current path prefix (used in recursion)
 * @returns Array of [key, value] tuples with dot-separated paths
 */
function flattenConfig(obj: Record<string, unknown>, prefix = ''): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      entries.push(...flattenConfig(value as Record<string, unknown>, fullKey));
    } else {
      entries.push([fullKey, value]);
    }
  }
  return entries;
}

/**
 * Get default value for a config key from schema defaults.
 *
 * @param key - Dot-separated config path (e.g., 'server.port')
 * @returns Default value or undefined if key doesn't exist
 */
function getDefault(key: string): unknown {
  const parts = key.split('.');
  let current: unknown = USER_CONFIG_DEFAULTS;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Show all effective settings (pretty-printed table).
 *
 * Displays each config value with source indicator (default or config file).
 */
export function handleConfigDefault(store: ConfigStore): void {
  const config = store.getAll();
  const entries = flattenConfig(config as unknown as Record<string, unknown>);
  console.log(`DorkOS Configuration (${store.path})\n`);
  for (const [key, value] of entries) {
    if (key === 'version') continue;
    const defaultVal = getDefault(key);
    const source = JSON.stringify(value) === JSON.stringify(defaultVal) ? '(default)' : '(config)';
    const displayValue = value === null ? '\u2014' : String(value);
    console.log(`  ${key.padEnd(20)} ${displayValue.padEnd(14)} ${source}`);
  }
  console.log(`\nConfig file: ${store.path}`);
}

/**
 * Get a single config value by dot-path.
 *
 * @param store - Config storage instance
 * @param key - Dot-separated config path (e.g., 'tunnel.enabled')
 */
export function handleConfigGet(store: ConfigStore, key: string): void {
  const value = store.getDot(key);
  if (value === undefined) {
    console.error(`Unknown config key: ${key}`);
    process.exit(1);
  }
  console.log(formatConfigValue(value));
}

/**
 * Render a stored config value for a person reading a terminal.
 *
 * `String()` alone turns a list into `a,b` and an object into `[object Object]`,
 * neither of which a person could paste back. JSON is what the file holds, so it
 * is what a list or an object is shown as.
 *
 * @param value - A stored config value.
 * @returns The value as one line of text.
 */
function formatConfigValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Split a dot-path the way the config store itself does, so a key with a literal
 * dot in it survives the trip.
 *
 * `dorkos config set` used to hand the whole path to `ConfigStore.setDot`, which
 * is `dot-prop` underneath and treats a backslash as an escape \u2014 the only way to
 * name a key with a dot in it under the three record-shaped sections
 * (`providers`, `ui.shapes.agentDefaults`, `workbench.defaultViewers`). Now that
 * the CLI builds a patch object instead, a naive `split('.')` would quietly turn
 * one such key into two nested ones.
 *
 * @param key - A dot-path, possibly with `\.` escapes.
 * @returns The segments, unescaped.
 */
function splitDotPath(key: string): string[] {
  const segments: string[] = [];
  let current = '';
  for (let index = 0; index < key.length; index += 1) {
    const char = key[index];
    if (char === '\\' && index + 1 < key.length) {
      current += key[index + 1];
      index += 1;
    } else if (char === '.') {
      segments.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  segments.push(current);
  return segments;
}

/**
 * Turn `key = value` into the patch object the guarded write takes.
 *
 * @param key - A dot-path.
 * @param value - The parsed value.
 * @returns A nested object with `value` at `key`.
 */
function patchForPath(key: string, value: unknown): Record<string, unknown> {
  const segments = splitDotPath(key);
  const patch: Record<string, unknown> = {};
  let node = patch;
  for (const segment of segments.slice(0, -1)) {
    const child: Record<string, unknown> = {};
    node[segment] = child;
    node = child;
  }
  node[segments[segments.length - 1]!] = value;
  return patch;
}

/**
 * Set a single config value \u2014 through the same door the cockpit uses.
 *
 * ## Why this is not a `setDot` any more (DOR-1247)
 *
 * It used to write the leaf straight into the file. That meant the one command
 * anything with a shell can run was the one write with no write policy, no
 * Full-autonomy consent door, no validation and no line in the log:
 * `dorkos config set runtimes.claudeCode.defaultTrustStop autonomy` left an
 * install starting every new session bypassed, with `ui.autonomyAcknowledgedAt`
 * still `null` \u2014 a state the cockpit's door exists to make unreachable \u2014
 * and nothing on disk saying it had happened.
 *
 * It now goes through {@link CliConfigWriter.guarded}, which brings three things
 * with it besides the consent door. The whole config is validated before
 * anything is written, so a value the schema refuses is reported instead of
 * stored (`server.port notanumber` used to land in the file and make the server
 * fall back to a default it never mentioned). A setting DorkOS does not have is
 * said out loud rather than written into a corner of the file nothing reads. And
 * the write leaves the same audit line every other settings write leaves.
 *
 * @param store - Config storage instance
 * @param key - Dot-separated config path
 * @param rawValue - Raw string value from CLI (will be parsed)
 * @param writer - How to reach the server's guarded write.
 */
export async function handleConfigSet(
  store: ConfigStore,
  key: string,
  rawValue: string,
  writer: CliConfigWriter
): Promise<void> {
  const segments = splitDotPath(key);

  // A patch is a deep MERGE, and merging replaces a list wholesale rather than
  // reaching into it \u2014 so there is no patch that means "element 3 of this list".
  // Sent anyway, `{ '0': 'x' }` reaches Zod as an object where an array belongs
  // and comes back as "expected array, received object", which reads like a bug
  // in the value rather than a thing this command cannot do. Say so instead.
  const listIndex = segments.findIndex((segment) => /^\d+$/.test(segment));
  if (listIndex > 0) {
    const listPath = segments.slice(0, listIndex).join('.');
    console.error(`Cannot set one item of a list: ${key}`);
    console.error(
      `Set the whole ${listPath} list at once, or run \`dorkos config edit\` to change it in the file.`
    );
    process.exit(1);
  }

  const value = parseConfigValue(rawValue);
  const result = await writer.guarded(patchForPath(key, value), 'dorkos config set');

  if (!result.ok) {
    if (result.kind === 'invalid') {
      console.error(`Cannot set ${key}: ${result.error}`);
      for (const detail of result.details ?? []) console.error(`  - ${detail}`);
    } else {
      // The same sentence the cockpit shows for the same refusal \u2014 a refusal
      // that reads differently in two places teaches people they are two rules.
      console.error(result.refusal.message);
      // The cockpit's next step is a dialog it can open itself. A terminal has
      // none, so the sentence alone is a dead end: name the command that is the
      // terminal's version of that dialog.
      if (result.refusal.code === AUTONOMY_ACK_REQUIRED_CODE) {
        console.error(
          `Run \`${ACKNOWLEDGE_AUTONOMY_COMMAND}\` to read what it means and confirm, then try again.`
        );
      }
    }
    process.exit(1);
  }

  // Zod drops a key the schema does not declare, so a write that landed nothing
  // is how "there is no such setting" arrives here. Saying `Set \u2026` for it would
  // be a lie the person acts on.
  const stored = store.getDot(key);
  if (stored === undefined) {
    console.error(`Unknown config key: ${key}`);
    console.error('Run `dorkos config list` to see every setting.');
    process.exit(1);
  }

  for (const warning of result.warnings) {
    console.warn(`\u26a0  ${warning}`);
  }
  // What LANDED, read back, not what was asked for. They can differ \u2014 a schema
  // default filling in, a value normalized on the way through \u2014 and the whole
  // point of this command's other changes is that it stops claiming writes it
  // did not make.
  console.log(`Set ${key} = ${formatConfigValue(stored)}`);
}

/**
 * What a person reads before they agree to start every new session in Full
 * autonomy.
 *
 * The wording tracks the cockpit's own consent dialog rather than inventing a
 * second version: the middle paragraph is the scope note the dialog renders
 * verbatim (`permission-mode-scope-note.tsx`), because a person who reads one
 * sentence in the app and a different one in a terminal has been told two
 * things about one setting.
 *
 * What it deliberately does NOT copy is the per-runtime promise the dialog puts
 * at the top. That sentence comes off a runtime's own profile, which a terminal
 * with no server cannot read — a stand-in would be wrong for somebody's agent.
 */
const AUTONOMY_CONSENT_TEXT = [
  'Starting every new session in Full autonomy means your agents stop asking first.',
  '',
  'A session that starts this way runs its tools without showing you an approval',
  'card — no pause, no chance to say no, for every new session from now on until',
  'you change it back.',
  '',
  'This covers tools inside the session. Actions on DorkOS itself, like removing',
  'packages, still ask.',
  '',
  'DorkOS records that you agreed, with today’s date, so it stops asking you this.',
  'You can take that back at any time in Settings, or with',
  '`dorkos config set ui.autonomyAcknowledgedAt null` — which also puts any',
  'standing Full-autonomy default back to asking.',
].join('\n');

/**
 * `dorkos config acknowledge-autonomy` — read what Full autonomy means, say yes,
 * and record it.
 *
 * ## Why the terminal needs its own door (DOR-1247)
 *
 * The consent record is what the config door asks for, and the cockpit gives it
 * through a dialog. A terminal had no way to produce one: `dorkos config set
 * runtimes.claudeCode.defaultTrustStop autonomy` was refused with a sentence and
 * no next step, which is a dead end for anyone who does not already know that
 * `ui.autonomyAcknowledgedAt` exists.
 *
 * So this is the terminal's version of that dialog, and it is deliberately the
 * same shape: it PRINTS what the person is agreeing to, then asks once, with no
 * as the default. Writing the record without reading it is still possible
 * (`config set ui.autonomyAcknowledgedAt <date>`), and that is a stated part of
 * the trust model rather than a hole this closes — a person with a shell can
 * sign their own form. See `config-write.ts` and
 * `contributing/configuration.md`.
 *
 * ## Why it refuses when nothing is attached
 *
 * A ritual needs somebody to perform it. With no TTY there is nobody to read the
 * text or answer, so a `--yes`-style flag here would be a consent form that
 * signs itself — the exact thing the door exists to prevent. A script that
 * genuinely means it can still write the record directly, which at least says
 * plainly what it is doing.
 *
 * The write goes through the guarded step like every other, so it lands in the
 * audit log: agreeing to this is itself a change worth being able to find later.
 *
 * @param store - Config storage instance
 * @param writer - How to reach the server's guarded write.
 * @param prompt - How the question reaches a person; injected for tests.
 */
export async function handleConfigAcknowledgeAutonomy(
  store: ConfigStore,
  writer: CliConfigWriter,
  prompt: ConsentPrompt = terminalConsentPrompt
): Promise<void> {
  const existing = store.getDot('ui.autonomyAcknowledgedAt');
  if (typeof existing === 'string' && existing.length > 0) {
    console.log(`You already confirmed this on ${existing}.`);
    console.log(
      'To take it back, run `dorkos config set ui.autonomyAcknowledgedAt null`, or use Settings.'
    );
    return;
  }

  if (!prompt.available()) {
    console.error('This needs to ask you a question, and nothing is attached to answer it.');
    console.error('Run it in a terminal, or confirm it in DorkOS under Settings.');
    process.exit(1);
  }

  console.log(`\n${AUTONOMY_CONSENT_TEXT}\n`);
  const agreed = await prompt.ask('Start every new session in Full autonomy?');
  if (!agreed) {
    console.log('Nothing changed.');
    return;
  }

  const acknowledgedAt = new Date().toISOString();
  const result = await writer.guarded(
    { ui: { autonomyAcknowledgedAt: acknowledgedAt } },
    ACKNOWLEDGE_AUTONOMY_COMMAND
  );
  if (!result.ok) {
    const reason = result.kind === 'invalid' ? result.error : result.refusal.message;
    console.error(`Could not record your answer: ${reason}`);
    process.exit(1);
  }

  console.log(`Recorded on ${acknowledgedAt}.`);
  console.log(
    'You can now set a Full-autonomy default, for example: `dorkos config set runtimes.defaultTrustStop autonomy`.'
  );
}

/**
 * How a consent question reaches a person.
 *
 * Two methods rather than one, because "is there anybody there?" and "what did
 * they say?" are different questions and the first has no honest boolean answer
 * from inside the second. Injected so the consent verb can be driven both ways
 * in a test — a vitest worker has no TTY, so a bare `process.stdin.isTTY` check
 * inside the handler made every path untestable except the refusal.
 */
export interface ConsentPrompt {
  /** Whether there is a person attached who could read the text and answer. */
  available(): boolean;
  /**
   * Ask the yes/no question.
   *
   * @param message - The question.
   */
  ask(message: string): Promise<boolean>;
}

/**
 * The real terminal: a TTY on stdin, and a yes/no that defaults to no.
 *
 * The prompt library is a lazy import so `dorkos config get` never pays to load
 * it.
 */
const terminalConsentPrompt: ConsentPrompt = {
  available: () => process.stdin.isTTY === true,
  async ask(message) {
    const { confirm } = await import('@inquirer/prompts');
    return confirm({ message, default: false });
  },
};

/**
 * Output full config as JSON.
 *
 * Useful for scripting and debugging.
 */
export function handleConfigList(store: ConfigStore): void {
  console.log(JSON.stringify(store.getAll(), null, 2));
}

/**
 * Reset config to defaults (all or specific key).
 *
 * No write policy, no consent door and no audit line, unlike
 * {@link handleConfigSet}, and the asymmetry is deliberate rather than a gap
 * left over from DOR-1247. Reset can only move a setting TO the value a fresh
 * install carries, and a fresh install's value is the protective one by rule
 * (ADR 260727-181825) — a whole-config reset additionally keeps the protections
 * a person moved (`safe-defaults/protected-state.ts`). So there is no reset that
 * turns a gate off, licenses Full autonomy, or widens a bound, which is the
 * entire set of things the guarded step is there to catch.
 *
 * `contributing/configuration.md` lists it among the writers that still leave no
 * line, with this reasoning, so nobody reads the silence as an oversight.
 *
 * @param store - Config storage instance
 * @param key - Optional specific key to reset; omit to reset all
 */
export function handleConfigReset(store: ConfigStore, key?: string): void {
  if (key) {
    store.reset(key);
    const defaultVal = getDefault(key);
    console.log(`Reset ${key} to default (${defaultVal === null ? 'null' : String(defaultVal)})`);
  } else {
    store.reset();
    console.log('Reset all settings to defaults');
  }
}

/**
 * Open config file in $EDITOR.
 *
 * Falls back to platform defaults (notepad on Windows, nano elsewhere).
 */
export function handleConfigEdit(store: ConfigStore): void {
  const editor = process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano');
  try {
    execFileSync(editor, [store.path], { stdio: 'inherit' });
  } catch {
    console.error(`Failed to open editor: ${editor}`);
    console.error(`Set $EDITOR or ensure ${editor} is installed.`);
    process.exit(1);
  }
}

/**
 * Print config file path.
 *
 * Useful for locating the config file in scripts.
 */
export function handleConfigPath(store: ConfigStore): void {
  console.log(store.path);
}

/**
 * Validate config against schema.
 *
 * Exits with code 0 if valid, 1 if invalid. A setting whose value was written by
 * a newer version of DorkOS is printed as a note, not a failure — the file is
 * fine, this version just cannot read that one value (DOR-1227).
 */
export function handleConfigValidate(store: ConfigStore): void {
  const result = store.validate();
  const printWarnings = (): void => {
    if (!result.warnings?.length) return;
    console.log('');
    console.log('Settings saved by a newer version of DorkOS, which this one cannot read:');
    for (const warning of result.warnings) console.log(`  - ${warning}`);
    console.log('They are still in your file, and the version that wrote them will use them.');
  };
  if (result.valid) {
    console.log('Config is valid');
    printWarnings();
    process.exit(0);
  } else {
    console.error('Config validation failed:');
    for (const err of result.errors ?? []) {
      console.error(`  - ${err}`);
    }
    printWarnings();
    process.exit(1);
  }
}

/**
 * Route config subcommands to appropriate handlers.
 *
 * @param store - Config storage instance
 * @param args - Positional arguments after 'config' command
 * @param writer - How to reach the server's config-write code. Required rather
 *   than defaulted, so no path can reach a write without one being chosen for it.
 */
export async function handleConfigCommand(
  store: ConfigStore,
  args: string[],
  writer: CliConfigWriter
): Promise<void> {
  const subcommand = args[0];
  switch (subcommand) {
    case undefined:
      handleConfigDefault(store);
      break;
    case 'get':
      if (!args[1]) {
        console.error('Usage: dorkos config get <key>');
        process.exit(1);
      }
      handleConfigGet(store, args[1]);
      break;
    case 'set':
      if (!args[1] || !args[2]) {
        console.error('Usage: dorkos config set <key> <value>');
        process.exit(1);
      }
      await handleConfigSet(store, args[1], args[2], writer);
      break;
    case 'list':
      handleConfigList(store);
      break;
    case 'reset':
      handleConfigReset(store, args[1]);
      break;
    case 'edit':
      handleConfigEdit(store);
      break;
    case 'path':
      handleConfigPath(store);
      break;
    case 'validate':
      handleConfigValidate(store);
      break;
    case 'acknowledge-autonomy':
      await handleConfigAcknowledgeAutonomy(store, writer);
      break;
    default:
      console.error(`Unknown config subcommand: ${subcommand}`);
      console.error('Available: get, set, list, reset, edit, path, validate, acknowledge-autonomy');
      process.exit(1);
  }
}
