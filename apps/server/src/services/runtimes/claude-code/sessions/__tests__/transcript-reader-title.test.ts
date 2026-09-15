import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, appendFile, mkdir, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Hoisted holder so getSessionInfo's mock resolution can vary per test.
const hoisted = vi.hoisted(() => ({
  sdkInfo: undefined as { customTitle?: string } | undefined,
  configDirForActive: '' as string,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getSessionInfo: vi.fn(() => Promise.resolve(hoisted.sdkInfo)),
}));
vi.mock('../../claude-config-dir.js', () => ({
  resolveActiveClaudeRoot: () => hoisted.configDirForActive,
  resolveClaudeRootSet: () => [hoisted.configDirForActive],
}));
vi.mock('../../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue(undefined),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue(undefined),
}));

import { TranscriptReader } from '../transcript-reader.js';

/** A realistic head/user JSONL line carrying the first prompt, cwd, and a timestamp. */
function userLine(text: string, cwd = '/work/ctx'): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
    timestamp: '2026-07-01T00:00:00.000Z',
    cwd,
  });
}

/** A standalone `ai-title` bookkeeping record — no `message`, no `timestamp`. */
function aiTitleLine(sessionId: string, aiTitle: string): string {
  return JSON.stringify({ type: 'ai-title', aiTitle, sessionId });
}

/** A standalone `custom-title` bookkeeping record, written by `/rename`. */
function customTitleLine(sessionId: string, customTitle: string): string {
  return JSON.stringify({ type: 'custom-title', customTitle, sessionId });
}

async function writeTranscript(dir: string, sessionId: string, lines: string[]): Promise<string> {
  const filePath = join(dir, `${sessionId}.jsonl`);
  await writeFile(filePath, lines.join('\n') + '\n');
  return filePath;
}

describe('TranscriptReader title precedence (DOR-2083)', () => {
  let reader: TranscriptReader;
  let dir: string;

  beforeEach(async () => {
    reader = new TranscriptReader();
    dir = await mkdtemp(join(tmpdir(), 'transcript-title-'));
    hoisted.sdkInfo = undefined;
    // Reset alongside sdkInfo — a value leaked from the '/rename still wins'
    // test would make an UNRELATED session's transcript directory read as the
    // active account in a later test, silently arming the SDK customTitle path
    // it must not reach.
    hoisted.configDirForActive = '';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('gives the AI-generated title when an ai-title record exists and no custom-title does', async () => {
    // Purpose: a room-started session whose SDK title landed as `ai-title`
    // records must show that title, not the operator's first prompt — the
    // exact bug reported in FB-30.
    await writeTranscript(dir, 'sess-ai', [
      userLine('@meeting-notes please review all of our notes from last week'),
      aiTitleLine('sess-ai', 'Review last week meeting notes'),
    ]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.title).toBe('Review last week meeting notes');
  });

  it('takes the LATEST ai-title when several were recorded', async () => {
    // Purpose: the SDK appends a fresh ai-title record as the conversation
    // evolves (44 in the reported transcript) — the current title is the
    // last one in file order, not the first.
    await writeTranscript(dir, 'sess-ai-multi', [
      userLine('find capital of Portugal'),
      aiTitleLine('sess-ai-multi', 'Find capital of Portugal'),
      aiTitleLine('sess-ai-multi', 'Portugal capital and history'),
      aiTitleLine('sess-ai-multi', 'Portugal capital, history, and culture'),
    ]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.title).toBe('Portugal capital, history, and culture');
  });

  it('derives from the first message verbatim when no title record exists at all', async () => {
    // Purpose: DOR-2083 review — the reader does not know at derivation time
    // whether a message came from a room (that overlay runs later, on the
    // aggregated session list), so it must NOT opt into mention-stripping;
    // a leading @-token that happens to be real content (`@override`,
    // `@media`, …) must survive untouched, same as any other fallback title.
    await writeTranscript(dir, 'sess-none', [userLine('do the thing')]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.title).toBe('Do the thing');
  });

  it('does not strip a leading @-token from the fallback derivation (no room-turn signal at read time)', async () => {
    await writeTranscript(dir, 'sess-mention-kept', [userLine('@agent do the thing')]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.title).toBe('@agent do the thing');
  });

  it('/rename still wins over a later ai-title', async () => {
    // Purpose: precedence is customTitle > ai-title > derived — an explicit
    // rename must not be clobbered by the SDK's own auto-titling.
    // The SDK-backed customTitle lookup only fires for the ACTIVE account
    // (D8), so this session must live at {accountRoot}/projects/{slug}/ with
    // resolveActiveClaudeRoot pointed at that same accountRoot.
    const vaultRoot = '/work/renamed';
    const slug = reader.getProjectSlug(vaultRoot);
    hoisted.sdkInfo = { customTitle: 'Renamed in the app' };
    hoisted.configDirForActive = dir;
    const projectDir = join(dir, 'projects', slug);
    await mkdir(projectDir, { recursive: true });
    await writeTranscript(projectDir, 'sess-renamed', [
      userLine('@meeting-notes please review all of our notes', vaultRoot),
      customTitleLine('sess-renamed', 'Renamed in the app'),
      aiTitleLine('sess-renamed', 'Review meeting notes'),
    ]);

    const session = await reader.getSession(vaultRoot, 'sess-renamed');
    expect(session?.title).toBe('Renamed in the app');
  });

  it('/rename still wins on a NON-active account, even with a newer ai-title', async () => {
    // Purpose: the SDK-backed customTitle lookup (resolveSdkTitle) is gated to
    // the active account (D8) and returns {} here on purpose — configDirForActive
    // is left at '' by beforeEach, so this transcript's account can never match
    // it. Without reading the transcript's OWN `custom-title` record, a rename
    // on this account would fall through past customTitle straight to
    // tailStatus.aiTitle, which is newer and would silently win — the DOR-2083
    // review bug. `hoisted.sdkInfo` is also left undefined so nothing besides
    // the transcript itself can be supplying the rename.
    await writeTranscript(dir, 'sess-nonactive-renamed', [
      userLine('@meeting-notes please review all of our notes'),
      customTitleLine('sess-nonactive-renamed', 'Renamed in the app'),
      aiTitleLine('sess-nonactive-renamed', 'Review meeting notes'),
    ]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.title).toBe('Renamed in the app');
  });

  it('updates the title live when a fresh ai-title lands, with no stale echo on re-read', async () => {
    // Purpose: DOR-2083 task 3 — the session-list watcher's rescan re-reads
    // metadata via the SAME mtime-keyed cache exercised here; the fix must not
    // require a reload to pick up a title that changed after the first list.
    const filePath = await writeTranscript(dir, 'sess-live', [
      userLine('please review all of our notes'),
    ]);

    const [before] = await reader.listSessionsInDir(dir);
    expect(before?.title).toBe('Review all of our notes');

    // Append the AI title and bump the mtime — what a live-arriving SDK title
    // record looks like on disk.
    await appendFile(filePath, aiTitleLine('sess-live', 'Review last week meeting notes') + '\n');
    await utimes(filePath, new Date(), new Date(Date.now() + 10_000));

    const [after] = await reader.listSessionsInDir(dir);
    expect(after?.title).toBe('Review last week meeting notes');
  });
});
