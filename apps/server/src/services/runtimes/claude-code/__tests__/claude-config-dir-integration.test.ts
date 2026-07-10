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
  const ORIGINAL_ENV = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'claude-config-dir-'));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    // A real directory, distinct from configDir, that stands in for the
    // user's project cwd. Boundary-scoped to configDir so validateBoundary
    // (a real production check) passes without weakening it for the test.
    vaultRoot = join(configDir, 'vault');
    await mkdir(vaultRoot, { recursive: true });
    await initBoundary(configDir);
  });

  afterEach(async () => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = ORIGINAL_ENV;
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

  it('watchSessionList, defaulting to TranscriptReader.getProjectsRoot(), discovers a session under the custom config dir', async () => {
    const reader = new TranscriptReader();
    await seedTranscript(reader, 'session-a1');

    // No projectsRoot passed — this is the default-parameter path
    // (`= transcriptReader.getProjectsRoot()`) that the fleet-wide watcher
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
