/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBetterAuthSecret } from '../secret.js';

const SECRET_FILE = 'better-auth-secret';

describe('resolveBetterAuthSecret', () => {
  let tmpDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-secret-'));
    savedEnv = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedEnv === undefined) {
      delete process.env.BETTER_AUTH_SECRET;
    } else {
      process.env.BETTER_AUTH_SECRET = savedEnv;
    }
  });

  it('generates and persists a secret when none exists', () => {
    const secretPath = path.join(tmpDir, SECRET_FILE);
    expect(fs.existsSync(secretPath)).toBe(false);

    const secret = resolveBetterAuthSecret(tmpDir);

    // 32 random bytes → 64 hex chars, comfortably past Better Auth's minimum.
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(secretPath)).toBe(true);
    expect(fs.readFileSync(secretPath, 'utf8')).toBe(secret);
  });

  it('persists the secret with owner-only (0600) permissions', () => {
    resolveBetterAuthSecret(tmpDir);
    const mode = fs.statSync(path.join(tmpDir, SECRET_FILE)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns the same secret across calls (stable across restarts)', () => {
    const first = resolveBetterAuthSecret(tmpDir);
    const second = resolveBetterAuthSecret(tmpDir);
    expect(second).toBe(first);
  });

  it('reads an already-persisted secret rather than regenerating', () => {
    const existing = 'a'.repeat(64);
    fs.writeFileSync(path.join(tmpDir, SECRET_FILE), existing, { mode: 0o600 });
    expect(resolveBetterAuthSecret(tmpDir)).toBe(existing);
  });

  it('trims surrounding whitespace from a persisted secret', () => {
    const existing = 'b'.repeat(64);
    fs.writeFileSync(path.join(tmpDir, SECRET_FILE), `\n${existing}\n`, { mode: 0o600 });
    expect(resolveBetterAuthSecret(tmpDir)).toBe(existing);
  });

  it('lets an explicit BETTER_AUTH_SECRET env var win over the persisted file', () => {
    const persisted = 'c'.repeat(64);
    fs.writeFileSync(path.join(tmpDir, SECRET_FILE), persisted, { mode: 0o600 });
    process.env.BETTER_AUTH_SECRET = 'operator-provided-secret-value';

    expect(resolveBetterAuthSecret(tmpDir)).toBe('operator-provided-secret-value');
    // The env override must not overwrite the persisted file.
    expect(fs.readFileSync(path.join(tmpDir, SECRET_FILE), 'utf8')).toBe(persisted);
  });

  it('lets an explicit env var short-circuit generation (no file written)', () => {
    process.env.BETTER_AUTH_SECRET = 'operator-provided-secret-value';
    expect(resolveBetterAuthSecret(tmpDir)).toBe('operator-provided-secret-value');
    expect(fs.existsSync(path.join(tmpDir, SECRET_FILE))).toBe(false);
  });

  it('treats a whitespace-only env var as unset and generates instead', () => {
    process.env.BETTER_AUTH_SECRET = '   ';
    const secret = resolveBetterAuthSecret(tmpDir);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(tmpDir, SECRET_FILE))).toBe(true);
  });
});
