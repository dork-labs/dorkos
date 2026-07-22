import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Hoisted holder so the config-dir mock points the projects root at a temp dir
// (empty → the reader finds no transcript files, but the boundary check still runs).
const hoisted = vi.hoisted(() => ({ configDir: '' }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getSessionInfo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../claude-config-dir.js', () => ({
  resolveClaudeConfigDir: () => hoisted.configDir,
}));
// NB: the boundary module is deliberately NOT mocked. This test exercises the
// REAL DorkHome-aware seam through the reader — the layer that 403'd the
// onboarding DorkBot session's events stream (DOR-417). A mocked boundary (as
// the sibling reader tests use) would hide exactly the bug this guards.

import { TranscriptReader } from '../transcript-reader.js';
import { initBoundary } from '../../../../../lib/boundary.js';

const SID = '00000000-0000-4000-8000-000000000001';

describe('TranscriptReader boundary — DorkHome-aware seam (real boundary)', () => {
  let reader: TranscriptReader;
  let boundaryRoot: string;
  let dorkHome: string;
  let outside: string;
  let agentHome: string;
  const origDorkHome = process.env.DORK_HOME;

  beforeEach(async () => {
    reader = new TranscriptReader();
    // A narrow boundary that does NOT contain dork-home — the Docker shape
    // (DORKOS_BOUNDARY=/workspace, dork-home at /home/node/.dork).
    boundaryRoot = await mkdtemp(join(tmpdir(), 'dor417-boundary-'));
    dorkHome = await mkdtemp(join(tmpdir(), 'dor417-dorkhome-'));
    outside = await mkdtemp(join(tmpdir(), 'dor417-outside-'));
    agentHome = join(dorkHome, 'agents', 'dorkbot');
    await mkdir(agentHome, { recursive: true });
    process.env.DORK_HOME = dorkHome;
    await initBoundary(boundaryRoot);
    hoisted.configDir = await mkdtemp(join(tmpdir(), 'dor417-claude-'));
  });

  afterEach(async () => {
    if (origDorkHome === undefined) delete process.env.DORK_HOME;
    else process.env.DORK_HOME = origDorkHome;
    await Promise.all([
      rm(boundaryRoot, { recursive: true, force: true }),
      rm(dorkHome, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
      rm(hoisted.configDir, { recursive: true, force: true }),
    ]);
  });

  it('reads an agent-home ({dorkHome}/agents/*) transcript under a narrow boundary (no boundary error)', async () => {
    // The plain boundary would 403 this path; the DorkHome-aware seam allows it,
    // so the reader proceeds (and returns empty, since no transcript exists yet).
    await expect(reader.readTranscript(agentHome, SID)).resolves.toEqual([]);
    await expect(reader.listTranscripts(agentHome)).resolves.toEqual([]);
  });

  it('still rejects a dork-home path outside agents/* (the credential store)', async () => {
    const secrets = join(dorkHome, 'extension-secrets', 'x');
    await expect(reader.readTranscript(secrets, SID)).rejects.toThrow('outside directory boundary');
  });

  it('still rejects a boundary-external path', async () => {
    await expect(reader.readTranscript(outside, SID)).rejects.toThrow('outside directory boundary');
  });
});
