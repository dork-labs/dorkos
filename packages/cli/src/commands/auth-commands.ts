/**
 * Core logic for the `dorkos auth` subcommands (`enable`, `reset-password`).
 *
 * These are the pure, dependency-injected handlers: they take an already-built
 * Better Auth instance, the `@dorkos/db` database, a config store, an I/O sink,
 * and a credential-prompt seam. All process-level wiring (opening the DB,
 * resolving `~/.dork`, reading a TTY vs stdin, calling `process.exit`) lives in
 * `auth-runtime.ts` and `auth-dispatcher.ts`, so this module unit-tests without
 * touching the real environment.
 *
 * @module commands/auth-commands
 */
import { parseArgs } from 'node:util';
import { user, eq, type Db } from '@dorkos/db';
import type { ConfigStore } from '../config-commands.js';

/**
 * Minimal structural shape of the Better Auth instance the auth commands drive.
 *
 * Kept structural (rather than importing the concrete Better Auth type) so this
 * module stays decoupled from `better-auth` — the real instance from
 * `createOwnerAuth` satisfies this at runtime.
 */
export interface OwnerAuth {
  api: {
    signUpEmail(input: {
      body: { name: string; email: string; password: string };
    }): Promise<unknown>;
  };
  $context: Promise<{
    password: {
      hash(password: string): Promise<string>;
      config: { minPasswordLength: number };
    };
    internalAdapter: {
      findAccounts(userId: string): Promise<Array<{ providerId: string }>>;
      updatePassword(userId: string, hashedPassword: string): Promise<void>;
      createAccount(account: {
        userId: string;
        providerId: string;
        accountId: string;
        password: string;
      }): Promise<unknown>;
    };
  }>;
}

/** A source of credential values (interactive prompt or piped stdin). */
export interface CredentialPrompt {
  /** Ask for the owner email. */
  email(): Promise<string>;
  /**
   * Ask for a password.
   *
   * @param options.confirm - When true, ask twice and require the entries to
   *   match (interactive only; non-interactive sources ignore this).
   */
  password(options: { confirm: boolean }): Promise<string>;
}

/** Where command output goes. Injected so tests can capture it. */
export interface CommandIO {
  log(message: string): void;
  error(message: string): void;
}

/** Injected dependencies for {@link runAuthEnable}. */
export interface AuthEnableDeps {
  options: { email?: string; password?: string };
  auth: OwnerAuth;
  db: Db;
  configStore: ConfigStore;
  prompt: CredentialPrompt;
  io: CommandIO;
}

/** Injected dependencies for {@link runAuthResetPassword}. */
export interface AuthResetPasswordDeps {
  options: { password?: string };
  auth: OwnerAuth;
  db: Db;
  prompt: CredentialPrompt;
  io: CommandIO;
}

/** Parsed flags for `dorkos auth enable`. */
export interface AuthEnableArgs {
  email?: string;
  password?: string;
  help: boolean;
}

/** Parsed flags for `dorkos auth reset-password`. */
export interface AuthResetPasswordArgs {
  password?: string;
  help: boolean;
}

/**
 * Parse the argv slice after `dorkos auth enable`.
 *
 * @param args - Arguments following the `enable` subcommand.
 */
export function parseAuthEnableArgs(args: string[]): AuthEnableArgs {
  const { values } = parseArgs({
    args,
    options: {
      email: { type: 'string' },
      password: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });
  return { email: values.email, password: values.password, help: Boolean(values.help) };
}

/**
 * Parse the argv slice after `dorkos auth reset-password`.
 *
 * @param args - Arguments following the `reset-password` subcommand.
 */
export function parseAuthResetPasswordArgs(args: string[]): AuthResetPasswordArgs {
  const { values } = parseArgs({
    args,
    options: {
      password: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });
  return { password: values.password, help: Boolean(values.help) };
}

/**
 * A non-interactive credential source that hands out newline-separated values
 * from a captured stdin buffer in order (used when stdin is not a TTY).
 *
 * @param raw - The full stdin contents.
 */
export function createStdinPrompt(raw: string): CredentialPrompt {
  const lines = raw.split('\n').map((line) => line.replace(/\r$/, ''));
  let index = 0;
  const next = (): string => (index < lines.length ? lines[index++] : '');
  return {
    email: async () => next(),
    // `confirm` is meaningless for a piped value — consume a single line.
    password: async () => next(),
  };
}

/** The owner account, when one exists. */
interface OwnerRow {
  id: string;
  email: string;
}

/**
 * Find the owner account in the local database.
 *
 * Prefers the user stamped `role: 'owner'`; falls back to the sole user when a
 * single account exists without the stamp (defensive — the P1 instance is
 * single-user).
 *
 * @param db - The consolidated `@dorkos/db` database.
 */
export function findOwnerUser(db: Db): OwnerRow | undefined {
  const owner = db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(eq(user.role, 'owner'))
    .limit(1)
    .get();
  if (owner) return owner;
  const all = db.select({ id: user.id, email: user.email }).from(user).limit(2).all();
  return all.length === 1 ? all[0] : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `dorkos auth enable`: create the owner account, then require login.
 *
 * Registration is owner-only: if any user already exists this fails fast
 * without prompting and without writing config. On success it creates the owner
 * (stamped `role: 'owner'` by the auth factory's hook) and flips `auth.enabled`
 * to `true` in `~/.dork/config.json`.
 *
 * @param deps - Injected auth instance, database, config store, prompt, and I/O.
 * @returns Process exit code (`0` success, `1` failure).
 */
export async function runAuthEnable(deps: AuthEnableDeps): Promise<number> {
  const { db, auth, configStore, prompt, io, options } = deps;

  // Fast-fail before prompting: registration is closed once an owner exists.
  const existing = db.select({ id: user.id }).from(user).limit(1).get();
  if (existing) {
    io.error('An owner account already exists for this DorkOS instance.');
    io.error('To reset its password, run: dorkos auth reset-password');
    return 1;
  }

  const email = (options.email ?? (await prompt.email())).trim();
  const password = options.password ?? (await prompt.password({ confirm: true }));

  if (!email) {
    io.error('An email is required.');
    return 1;
  }
  if (!password) {
    io.error('A password is required.');
    return 1;
  }

  try {
    // `name` is required by Better Auth; the owner can be renamed later, so the
    // email doubles as the initial display name.
    await auth.api.signUpEmail({ body: { name: email, email, password } });
  } catch (err) {
    io.error(`Could not create the owner account: ${errorMessage(err)}`);
    return 1;
  }

  // Only flip the flag after the account exists — a failed sign-up must leave
  // config untouched.
  configStore.setDot('auth.enabled', true);

  io.log(`Owner account created for ${email}.`);
  io.log('Login is now required for this instance.');
  io.log('Restart any running DorkOS server for the change to take effect.');
  return 0;
}

/**
 * `dorkos auth reset-password`: set a new password on the owner account.
 *
 * Works with no running server and no SMTP: it hashes the new password with the
 * same scrypt configuration the server uses and writes it directly to the
 * owner's credential account.
 *
 * @param deps - Injected auth instance, database, prompt, and I/O.
 * @returns Process exit code (`0` success, `1` failure).
 */
export async function runAuthResetPassword(deps: AuthResetPasswordDeps): Promise<number> {
  const { db, auth, prompt, io, options } = deps;

  const owner = findOwnerUser(db);
  if (!owner) {
    io.error('No owner account found. Run `dorkos auth enable` first.');
    return 1;
  }

  const password = options.password ?? (await prompt.password({ confirm: true }));
  if (!password) {
    io.error('A password is required.');
    return 1;
  }

  const context = await auth.$context;
  const minLength = context.password.config.minPasswordLength;
  if (password.length < minLength) {
    io.error(`Password must be at least ${minLength} characters.`);
    return 1;
  }

  const hashedPassword = await context.password.hash(password);
  const accounts = await context.internalAdapter.findAccounts(owner.id);
  const hasCredential = accounts.some((entry) => entry.providerId === 'credential');
  if (hasCredential) {
    await context.internalAdapter.updatePassword(owner.id, hashedPassword);
  } else {
    // No credential account yet (e.g. the owner only ever had a social login) —
    // create one so the new password is usable.
    await context.internalAdapter.createAccount({
      userId: owner.id,
      providerId: 'credential',
      accountId: owner.id,
      password: hashedPassword,
    });
  }

  io.log(`Password reset for ${owner.email}.`);
  io.log('You can now sign in with the new password.');
  return 0;
}
