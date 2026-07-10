/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, runMigrations, user, type Db } from '@dorkos/db';
import { createOwnerAuth } from '../auth-instance.js';
import {
  runAuthEnable,
  runAuthResetPassword,
  createStdinPrompt,
  findOwnerUser,
  parseAuthEnableArgs,
  parseAuthResetPasswordArgs,
  type CredentialPrompt,
  type CommandIO,
  type OwnerAuth,
} from '../auth-commands.js';
import type { ConfigStore } from '../../config-commands.js';

// Emails are assembled from parts so the source never contains a literal address.
const DOMAIN = 'dork.test';
const OWNER_EMAIL = 'owner' + '@' + DOMAIN;
const OWNER_PASSWORD = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'a-totally-different-secret';

/** A config store backed by a real temp `config.json`, mirroring the CLI runtime. */
function createFileConfigStore(dorkHome: string): ConfigStore {
  const file = path.join(dorkHome, 'config.json');
  const read = (): Record<string, unknown> =>
    fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const write = (data: Record<string, unknown>): void =>
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return {
    getAll: () => read() as never,
    getDot: (key: string) =>
      key
        .split('.')
        .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], read()),
    setDot: (key: string, value: unknown) => {
      const data = read();
      const parts = key.split('.');
      let cursor = data;
      for (const part of parts.slice(0, -1)) {
        cursor[part] = (cursor[part] as Record<string, unknown>) ?? {};
        cursor = cursor[part] as Record<string, unknown>;
      }
      cursor[parts[parts.length - 1]] = value;
      write(data);
      return {};
    },
    reset: () => write({}),
    validate: () => ({ valid: true }),
    path: file,
  };
}

/** A prompt that fails loudly if invoked — proves the flags/stdin paths never prompt. */
const throwingPrompt: CredentialPrompt = {
  email: async () => {
    throw new Error('email prompt should not be called');
  },
  password: async () => {
    throw new Error('password prompt should not be called');
  },
};

function captureIo(): { io: CommandIO; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { io: { log: (m) => logs.push(m), error: (m) => errors.push(m) }, logs, errors };
}

describe('auth-commands', () => {
  let tmpDir: string;
  let db: Db;
  let auth: OwnerAuth;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-auth-cli-'));
    db = createDb(path.join(tmpDir, 'dork.db'));
    runMigrations(db);
    // A fixed test secret so owner creation can sign the (discarded) session.
    auth = createOwnerAuth(db, 'test-signing-secret-test-signing-secret') as unknown as OwnerAuth;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('parse helpers', () => {
    it('parses enable flags and --help', () => {
      expect(parseAuthEnableArgs(['--email', OWNER_EMAIL, '--password', 'pw'])).toEqual({
        email: OWNER_EMAIL,
        password: 'pw',
        help: false,
      });
      expect(parseAuthEnableArgs(['--help']).help).toBe(true);
    });

    it('parses reset-password flags and --help', () => {
      expect(parseAuthResetPasswordArgs(['--password', 'pw'])).toEqual({
        password: 'pw',
        help: false,
      });
      expect(parseAuthResetPasswordArgs(['-h']).help).toBe(true);
    });
  });

  describe('createStdinPrompt', () => {
    it('hands out newline-separated values in order', async () => {
      const prompt = createStdinPrompt(`${OWNER_EMAIL}\n${OWNER_PASSWORD}\n`);
      expect(await prompt.email()).toBe(OWNER_EMAIL);
      expect(await prompt.password({ confirm: true })).toBe(OWNER_PASSWORD);
    });
  });

  describe('runAuthEnable', () => {
    it('creates an owner (role=owner) and flips auth.enabled in config.json (flags path, no prompt)', async () => {
      const configStore = createFileConfigStore(tmpDir);
      const { io, logs } = captureIo();

      const code = await runAuthEnable({
        options: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
        auth,
        db,
        configStore,
        prompt: throwingPrompt,
        io,
      });

      expect(code).toBe(0);
      const owner = db.select().from(user).get();
      expect(owner?.email).toBe(OWNER_EMAIL);
      expect(owner?.role).toBe('owner');

      // Flag persisted to the real temp config.json.
      const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
      expect(persisted.auth.enabled).toBe(true);
      expect(logs.some((l) => l.includes('Restart'))).toBe(true);
    });

    it('resolves credentials from stdin when no flags are given (non-TTY)', async () => {
      const configStore = createFileConfigStore(tmpDir);
      const { io } = captureIo();

      const code = await runAuthEnable({
        options: {},
        auth,
        db,
        configStore,
        prompt: createStdinPrompt(`${OWNER_EMAIL}\n${OWNER_PASSWORD}\n`),
        io,
      });

      expect(code).toBe(0);
      expect(db.select().from(user).get()?.email).toBe(OWNER_EMAIL);
    });

    it('errors cleanly on a second enable without writing config', async () => {
      // First enable succeeds.
      const firstStore = createFileConfigStore(tmpDir);
      const first = captureIo();
      expect(
        await runAuthEnable({
          options: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
          auth,
          db,
          configStore: firstStore,
          prompt: throwingPrompt,
          io: first.io,
        })
      ).toBe(0);

      // Second enable: a fresh store over a config *without* auth.enabled.
      const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-auth-cli2-'));
      const secondStore = createFileConfigStore(secondDir);
      const second = captureIo();

      const code = await runAuthEnable({
        options: { email: 'intruder' + '@' + DOMAIN, password: 'another-password' },
        auth,
        db,
        configStore: secondStore,
        prompt: throwingPrompt,
        io: second.io,
      });

      expect(code).toBe(1);
      expect(second.errors.some((e) => e.includes('already exists'))).toBe(true);
      // No second user created, and the second store's config.json was never written.
      expect(db.select().from(user).all()).toHaveLength(1);
      expect(fs.existsSync(path.join(secondDir, 'config.json'))).toBe(false);
      fs.rmSync(secondDir, { recursive: true, force: true });
    });
  });

  describe('runAuthResetPassword', () => {
    it('errors when no owner exists', async () => {
      const { io, errors } = captureIo();
      const code = await runAuthResetPassword({
        options: { password: NEW_PASSWORD },
        auth,
        db,
        prompt: throwingPrompt,
        io,
      });
      expect(code).toBe(1);
      expect(errors.some((e) => e.includes('No owner account'))).toBe(true);
    });

    it('resets the credential so the owner can sign in with the new password', async () => {
      // Create the owner first.
      const store = createFileConfigStore(tmpDir);
      await runAuthEnable({
        options: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
        auth,
        db,
        configStore: store,
        prompt: throwingPrompt,
        io: captureIo().io,
      });

      const owner = findOwnerUser(db);
      expect(owner?.email).toBe(OWNER_EMAIL);

      const { io } = captureIo();
      const code = await runAuthResetPassword({
        options: { password: NEW_PASSWORD },
        auth,
        db,
        prompt: throwingPrompt,
        io,
      });
      expect(code).toBe(0);

      // Sign-in against a Better Auth instance over the same DB verifies the hash.
      const signInApi = auth as unknown as {
        api: {
          signInEmail(input: { body: { email: string; password: string } }): Promise<unknown>;
        };
      };
      await expect(
        signInApi.api.signInEmail({ body: { email: OWNER_EMAIL, password: NEW_PASSWORD } })
      ).resolves.toBeDefined();
      await expect(
        signInApi.api.signInEmail({ body: { email: OWNER_EMAIL, password: OWNER_PASSWORD } })
      ).rejects.toBeDefined();
    });

    it('rejects a password shorter than the minimum length', async () => {
      const store = createFileConfigStore(tmpDir);
      await runAuthEnable({
        options: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
        auth,
        db,
        configStore: store,
        prompt: throwingPrompt,
        io: captureIo().io,
      });

      const { io, errors } = captureIo();
      const code = await runAuthResetPassword({
        options: { password: 'short' },
        auth,
        db,
        prompt: throwingPrompt,
        io,
      });
      expect(code).toBe(1);
      expect(errors.some((e) => e.includes('at least'))).toBe(true);
    });
  });
});
