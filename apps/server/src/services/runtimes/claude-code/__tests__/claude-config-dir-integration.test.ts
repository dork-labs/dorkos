import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SessionListEvent } from '@dorkos/shared/session-stream';
import { TranscriptReader } from '../sessions/transcript-reader.js';
import { watchSessionList } from '../sessions/session-list-watcher.js';
import { initBoundary } from '../../../../lib/boundary.js';

/**
 * Proves DOR-250 end-to-end at the TranscriptReader/session-list-watcher
 * layer: with `CLAUDE_CONFIG_DIR` pointed at a temp directory (mirroring a
 * multi-config user, or an agent launched from inside a Claude Code session),
 * every read site must resolve transcripts from THAT directory, not the
 * real `~/.claude`. Real filesystem + real chokidar throughout — no mocks —
 * so this catches the exact split-brain the bug produced: the SDK writes to
 * `$CLAUDE_CONFIG_DIR`, and DorkOS must read from the same place.
 */
describe('CLAUDE_CONFIG_DIR honored by TranscriptReader and watchSessionList', () => {
  let configDir: string;
  let vaultRoot: string;
  const ORIGINAL = {
    configDir: process.env.CLAUDE_CONFIG_DIR,
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
  };

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'claude-config-dir-'));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    // Stage HOME as well (the technique `claude-config-dir.test.ts` uses, per
    // `.claude/rules/dork-home.md`). `~/.claude` is an unconditional member of
    // the account set, so without this the reads below would ALSO enumerate the
    // developer's real accounts — slow, and non-deterministic in exactly the
    // dimension this file is asserting. The staged home has no `.claude`, so the
    // account set is precisely `configDir`.
    process.env.HOME = configDir;
    process.env.USERPROFILE = configDir;
    // A real directory, distinct from configDir, that stands in for the
    // user's project cwd. Boundary-scoped to configDir so validateBoundary
    // (a real production check) passes without weakening it for the test.
    vaultRoot = join(configDir, 'vault');
    await mkdir(vaultRoot, { recursive: true });
    await initBoundary(configDir);
  });

  afterEach(async () => {
    for (const [key, value] of [
      ['CLAUDE_CONFIG_DIR', ORIGINAL.configDir],
      ['HOME', ORIGINAL.home],
      ['USERPROFILE', ORIGINAL.userProfile],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(configDir, { recursive: true, force: true });
  });

  /** Seed a fixture JSONL transcript under the custom config dir's projects root. */
  async function seedTranscript(reader: TranscriptReader, sessionId: string): Promise<void> {
    const slugDir = join(reader.getProjectsRoot(), reader.getProjectSlug(vaultRoot));
    await mkdir(slugDir, { recursive: true });
    await writeFile(
      join(slugDir, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello from a custom config dir' },
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: vaultRoot,
      }) + '\n'
    );
  }

  it('TranscriptReader.getProjectsRoot resolves under the custom config dir', () => {
    const reader = new TranscriptReader();
    expect(reader.getProjectsRoot()).toBe(join(configDir, 'projects'));
  });

  it('TranscriptReader.listSessions finds a transcript seeded under the custom config dir', async () => {
    const reader = new TranscriptReader();
    await seedTranscript(reader, 'session-a1');

    const sessions = await reader.listSessions(vaultRoot);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: 'session-a1', cwd: vaultRoot });
  });

  it('TranscriptReader.getSession reads a transcript seeded under the custom config dir', async () => {
    const reader = new TranscriptReader();
    await seedTranscript(reader, 'session-a1');

    const session = await reader.getSession(vaultRoot, 'session-a1');

    expect(session).toMatchObject({ id: 'session-a1', cwd: vaultRoot });
  });

  it('watchSessionList, defaulting to TranscriptReader.getProjectsRootSet(), discovers a session under the custom config dir', async () => {
    const reader = new TranscriptReader();
    await seedTranscript(reader, 'session-a1');
    // The default the assertion below rides on: the account set the watcher gets
    // is exactly the custom config dir, so a discovery event can only come from
    // there.
    expect(reader.getProjectsRootSet()).toEqual([join(configDir, 'projects')]);

    // No roots passed — this is the default-parameter path
    // (`= transcriptReader.getProjectsRootSet()`) that the fleet-wide watcher
    // actually runs with in production.
    const iterator = watchSessionList(reader)[Symbol.asyncIterator]();
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out waiting for initial inventory')), 15_000)
      );
      const result = (await Promise.race([iterator.next(), timeout])) as IteratorResult<
        SessionListEvent,
        void
      >;
      expect(result.done).toBe(false);
      expect(result.value).toMatchObject({
        type: 'session_upserted',
        session: { id: 'session-a1', cwd: vaultRoot },
      });
    } finally {
      await iterator.return?.();
    }
  }, 20_000);
});
