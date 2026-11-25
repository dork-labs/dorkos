import fs from 'fs';
import os from 'os';
import path from 'path';
import Conf, { type Schema } from 'conf';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { CONF_JSON_SCHEMA, CONFIG_MIGRATIONS } from '../../config-manager.js';

/**
 * Expected `runtimes` section defaults (spec: additional-agent-runtimes +
 * effortless-runtime-switching T1 credential fields + claude-code-accounts).
 */
export const RUNTIMES_DEFAULTS = {
  doe: { enabled: true, inference: null, defaultModel: null, defaultTrustStop: null },
  environment: { inherit: { claudeCode: [], codex: [], opencode: [], doe: [] } },
  default: 'claude-code',
  // Trusted by default (ADR 261006-225605): the global stop ships at Full
  // autonomy, and each runtime's own stop ships `null` so it follows it.
  defaultTrustStop: 'autonomy',
  maxAgentChats: 8,
  loadGate: {
    enabled: true,
    maxLoad: 16,
    slots: 1,
    maxWaitMinutes: 60,
    hardCapMinutes: 240,
    heavyCommands: { add: [], remove: [] },
  },
  claudeCode: {
    defaultAccount: null,
    accounts: [],
    defaultAccountColor: null,
    defaultAccountOnlyProjects: null,
    projectAccounts: {},
    dismissedFolders: [],
    defaultModel: null,
    defaultEffort: null,
    defaultTrustStop: null,
    // On: a chat's agent stays running between messages. Graduated out of
    // Experiments and flipped by the schema default (spec
    // `full-power-defaults`, D1); the `0.59.0` backfill that seeded it OFF is
    // unchanged and still pinned below.
    persistentSession: true,
    maxWarmProcesses: null,
  },
  opencode: {
    enabled: true,
    binaryPath: null,
    port: 0,
    provider: null,
    baseURL: null,
    // No `defaultEffort`: OpenCode's API accepts no effort at all.
    defaultModel: null,
    defaultTrustStop: null,
  },
  codex: {
    enabled: true,
    binaryPath: null,
    credentialRef: null,
    defaultModel: null,
    defaultEffort: null,
    defaultTrustStop: null,
    transport: 'auto',
  },
};

/**
 * Whether a config file in this directory has been backed up and replaced.
 *
 * Backups are timestamped and rotated (DOR-1221), so there is no one name to
 * look for. Matched by suffix rather than by the production module's own
 * pattern, so a change to the naming shows up here as a result rather than
 * being agreed with.
 *
 * @param dir - The data directory holding `config.json`.
 */
export function wasBackedUp(dir: string): boolean {
  return fs.readdirSync(dir).some((name) => name.endsWith('.bak'));
}

/** Minimal stand-in for the `conf` store used by migration bodies. */
export function createMockStore(initial: Record<string, unknown>) {
  const data: Record<string, unknown> = { ...initial };
  /** Every key a body wrote, so "it made no write at all" is assertable. */
  const writes: string[] = [];
  return {
    data,
    writes,
    get: (key: string) => data[key],
    has: (key: string) => data[key] !== undefined,
    set: (key: string, value: unknown) => {
      writes.push(key);
      data[key] = value;
    },
    delete: (key: string) => {
      delete data[key];
    },
  };
}

/**
 * Runs the real `conf` upgrade (schema, defaults, every migration) to `to`
 * over a config file last written at `from` holding `stored`, and returns the
 * raw text it wrote back.
 *
 * Read the FILE, not the store: Ajv's `useDefaults` answers from a discarded
 * copy, so a `getDot` assertion would pass with a migration body deleted
 * (DOR-1496).
 *
 * @param stored - The top-level sections of the stored file.
 * @param from - The migration version the file was last written at.
 * @param to - The version the upgrade runs to.
 */
export function upgradeConfigFileRaw(
  stored: Record<string, unknown>,
  from: string,
  to: string
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-dork-config-upgrade-'));
  const cfgPath = path.join(dir, 'config.json');
  try {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ version: 1, ...stored, __internal__: { migrations: { version: from } } }),
      'utf-8'
    );
    new Conf({
      configName: 'config',
      cwd: dir,
      schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
      defaults: USER_CONFIG_DEFAULTS,
      clearInvalidConfig: false,
      projectVersion: to,
      migrations: CONFIG_MIGRATIONS,
    });
    return fs.readFileSync(cfgPath, 'utf-8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** {@link upgradeConfigFileRaw}, parsed. */
export function upgradeConfigFile<T = Record<string, Record<string, unknown>>>(
  stored: Record<string, unknown>,
  from: string,
  to: string
): T {
  return JSON.parse(upgradeConfigFileRaw(stored, from, to)) as T;
}
