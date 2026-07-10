/**
 * Process-level wiring for the `dorkos auth` commands.
 *
 * This is the I/O boundary the pure handlers in `auth-commands.ts` are kept
 * clean of: it opens the local `~/.dork/dork.db` database, runs migrations so
 * the auth tables exist even when the server has never started, builds the
 * CLI-local Better Auth instance, resolves the config store, and picks a
 * credential source (interactive TTY prompts vs piped stdin). Tests never import
 * this module — they inject fakes directly into the handlers.
 *
 * @module commands/auth-runtime
 */
import path from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { input, password as passwordPrompt } from '@inquirer/prompts';
import { createDb, runMigrations } from '@dorkos/db';
import type { ConfigStore } from '../config-commands.js';
import { createOwnerAuth } from './auth-instance.js';
import {
  createStdinPrompt,
  type CredentialPrompt,
  type CommandIO,
  type OwnerAuth,
} from './auth-commands.js';

/** The runtime context both `dorkos auth` subcommands operate on. */
export interface AuthRuntime {
  auth: OwnerAuth;
  db: ReturnType<typeof createDb>;
  configStore: ConfigStore;
}

/**
 * Open the local database (creating + migrating it if needed), build the
 * CLI-local Better Auth instance over it, and resolve the config store.
 *
 * @param dorkHome - The resolved `~/.dork` data directory (set by `cli.ts`).
 */
export async function buildAuthRuntime(dorkHome: string): Promise<AuthRuntime> {
  // The data directory may not exist yet (reset-password can run before the
  // server ever started); create it so createDb + config can open there.
  mkdirSync(dorkHome, { recursive: true });
  // Same on-disk database the server opens (`apps/server/src/index.ts`).
  const db = createDb(path.join(dorkHome, 'dork.db'));
  runMigrations(db);

  // Resolve the signing secret the SAME way the server does (env → persisted
  // 0600 file → generate + persist), reusing the server module so both paths
  // converge on one secret. Without it `signUpEmail` throws the production
  // default-secret error and `auth enable` never creates the owner (DOR-242).
  // The build maps `../../server/...` to the server source tree.
  const { resolveBetterAuthSecret } = await import('../../server/services/core/auth/secret.js');
  const auth = createOwnerAuth(db, resolveBetterAuthSecret(dorkHome)) as unknown as OwnerAuth;

  // Reuse the server's config manager (already the CLI's config path — see the
  // `config`/`init` subcommands in cli.ts); the build maps `../../server/...`
  // to the server source.
  const { initConfigManager } = await import('../../server/services/core/config-manager.js');
  const configStore = initConfigManager(dorkHome);

  return { auth, db, configStore };
}

/** Command output routed to the console. */
export const consoleIo: CommandIO = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

/** Interactive (TTY) credential prompts with masked, confirmed password entry. */
function createInteractivePrompt(): CredentialPrompt {
  return {
    email: () => input({ message: 'Owner email:' }),
    password: async ({ confirm }) => {
      const value = await passwordPrompt({ message: 'Password:', mask: true });
      if (confirm) {
        const again = await passwordPrompt({ message: 'Confirm password:', mask: true });
        if (value !== again) {
          throw new Error('Passwords do not match.');
        }
      }
      return value;
    },
  };
}

/**
 * Choose a credential source: interactive prompts when attached to a TTY, or
 * piped stdin otherwise (so CI and scripts never hang).
 *
 * For the non-TTY case, stdin is read lazily on the first prompt — a
 * fully-flagged invocation (`--email` + `--password`) resolves without touching
 * stdin at all, so it never blocks waiting on an open-but-empty pipe.
 */
export function resolveCredentialPrompt(): CredentialPrompt {
  if (process.stdin.isTTY) {
    return createInteractivePrompt();
  }
  let stdinPrompt: CredentialPrompt | undefined;
  const load = (): CredentialPrompt => {
    if (!stdinPrompt) {
      let raw = '';
      try {
        // fd 0 = stdin; reads the piped buffer to EOF. Only reached when a
        // value is actually needed (not covered by a flag).
        raw = readFileSync(0, 'utf8');
      } catch {
        raw = '';
      }
      stdinPrompt = createStdinPrompt(raw);
    }
    return stdinPrompt;
  };
  return {
    email: () => load().email(),
    password: (options) => load().password(options),
  };
}
