/**
 * Permission modes recovered from a claude-code transcript.
 *
 * The reader translates the SDK's recorded mode into the DorkOS mode a session
 * row reports. Every mode the runtime declares needs its own arm: a catch-all
 * that collapses unknown values to `default` also collapses the real modes it
 * simply forgot to list, and the session list then tells the operator a session
 * is prompting on every tool when it is actually running unattended.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const hoisted = vi.hoisted(() => ({ configDir: '' }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getSessionInfo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../claude-config-dir.js', () => ({
  resolveActiveClaudeRoot: () => hoisted.configDir,
  resolveClaudeRootSet: () => [hoisted.configDir],
}));
vi.mock('../../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue(undefined),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue(undefined),
}));

import { TranscriptReader } from '../transcript-reader.js';

/** A user JSONL record carrying the SDK's recorded permission mode. */
function userLine(permissionMode?: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'hello' },
    timestamp: '2026-07-01T00:00:00.000Z',
    cwd: '/work/ctx',
    ...(permissionMode ? { permissionMode } : {}),
  });
}

/** A `system`/`init` JSONL record carrying the SDK's recorded permission mode. */
function initLine(permissionMode: string): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'init',
    permissionMode,
    timestamp: '2026-07-01T00:00:00.000Z',
  });
}

describe('TranscriptReader — permission mode recovery', () => {
  let reader: TranscriptReader;
  let dir: string;

  beforeEach(async () => {
    reader = new TranscriptReader();
    dir = await mkdtemp(join(tmpdir(), 'transcript-mode-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function readMode(sessionId: string, lines: string[]): Promise<string | undefined> {
    await writeFile(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
    const sessions = await reader.listSessionsInDir(dir);
    return sessions.find((session) => session.id === sessionId)?.permissionMode;
  }

  it.each(['default', 'plan', 'acceptEdits', 'bypassPermissions', 'auto', 'dontAsk'])(
    'reports a user record recorded in "%s" as itself',
    async (mode) => {
      expect(await readMode(`user-${mode}`, [userLine(mode)])).toBe(mode);
    }
  );

  it.each(['auto', 'dontAsk'])(
    'reports an init record recorded in "%s" as itself',
    async (mode) => {
      // The init record is the head-read source; a session that never re-records
      // its mode on a user turn is read from here alone.
      expect(await readMode(`init-${mode}`, [initLine(mode), userLine()])).toBe(mode);
    }
  );

  it('maps the legacy dangerously-skip alias to bypassPermissions', async () => {
    expect(await readMode('legacy', [userLine('dangerously-skip')])).toBe('bypassPermissions');
  });

  it('falls back to default for a mode this DorkOS build does not know', async () => {
    // An SDK that grows a mode ahead of DorkOS must degrade to the SAFEST
    // posture, never to a permissive one.
    expect(await readMode('unknown', [userLine('someFutureMode')])).toBe('default');
  });
});
