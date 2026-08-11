/**
 * `Session.lastUserMessageAt` — when the PERSON last wrote (BC-16).
 *
 * The whole value of the field is that it is NOT `updatedAt`: `updatedAt` is
 * the transcript's mtime and moves on every agent write, which is exactly the
 * signal the sidebar's Today zone must not reorder on. So every case here keeps
 * agent activity AFTER the person's last message and asserts the two instants
 * differ — a reader that relabelled `updatedAt`, or that counted the `user`-role
 * records the harness writes, fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Hoisted holder so the config-dir mock can be pointed at a per-test temp dir.
const hoisted = vi.hoisted(() => ({ configDir: '' }));

// The SDK title lookup is irrelevant here; stub it so extraction falls back to
// the first-message title with no real SDK I/O.
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

/** When the person wrote in every fixture below. */
const PERSON_WROTE_AT = '2026-07-01T09:00:00.000Z';
/** When the noise record under test arrives — always AFTER the person's turn. */
const NOISE_AT = '2026-07-01T09:30:00.000Z';
/** The transcript's mtime in every fixture: later still, so it can be told apart. */
const MTIME = new Date('2026-07-01T10:00:00.000Z');

/** The person's own message. */
function personLine(text = 'ship the ordering fix', at = PERSON_WROTE_AT): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
    timestamp: at,
    cwd: '/work/ctx',
  });
}

/** An assistant turn — the agent working after the person stopped typing. */
function assistantLine(at: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'working' }], model: 'opus' },
    timestamp: at,
  });
}

/**
 * Write a transcript and pin its mtime to {@link MTIME}, so `updatedAt` is a
 * known instant that no fixture's person-message shares.
 */
async function writeTranscript(dir: string, sessionId: string, lines: string[]): Promise<string> {
  const filePath = join(dir, `${sessionId}.jsonl`);
  await writeFile(filePath, lines.join('\n') + '\n');
  await utimes(filePath, MTIME, MTIME);
  return filePath;
}

describe('TranscriptReader — when the person last wrote (BC-16)', () => {
  let reader: TranscriptReader;
  let dir: string;

  beforeEach(async () => {
    reader = new TranscriptReader();
    dir = await mkdtemp(join(tmpdir(), 'transcript-last-user-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('reports the person’s own message, and it is EARLIER than updatedAt', async () => {
    // Purpose: the anti-rename case. The agent kept working for an hour after
    // the person stopped typing, so a field that reported `updatedAt` (or the
    // last record's timestamp) would land on a different, later instant.
    await writeTranscript(dir, 'sess-person', [
      personLine(),
      assistantLine('2026-07-01T09:01:00.000Z'),
      assistantLine('2026-07-01T09:45:00.000Z'),
    ]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.lastUserMessageAt).toBe(PERSON_WROTE_AT);
    expect(session?.updatedAt).toBe(MTIME.toISOString());
    expect(Date.parse(session!.lastUserMessageAt!)).toBeLessThan(Date.parse(session!.updatedAt));
  });

  it('takes the LAST of several messages from the person', async () => {
    await writeTranscript(dir, 'sess-many', [
      personLine('first'),
      assistantLine('2026-07-01T09:05:00.000Z'),
      personLine('and another thing', '2026-07-01T09:20:00.000Z'),
      assistantLine('2026-07-01T09:50:00.000Z'),
    ]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.lastUserMessageAt).toBe('2026-07-01T09:20:00.000Z');
  });

  // Every one of these arrives on the `user` role and none of them was typed by
  // a person. Counting any of them would make the field move whenever the agent
  // moved, which is the failure BC-16 exists to prevent.
  const notThePerson: { label: string; record: Record<string, unknown> }[] = [
    {
      label: 'a tool result',
      record: {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
        },
      },
    },
    {
      label: 'a tool result carrying SDK-internal text alongside it',
      record: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Skill expansion follows' },
            { type: 'tool_result', tool_use_id: 'tool-2', content: 'ok' },
          ],
        },
      },
    },
    {
      label: 'the CLI resume bootstrap (isMeta)',
      record: {
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: 'Continue from where you left off.' },
      },
    },
    {
      label: 'a subagent’s own turn (isSidechain)',
      record: {
        type: 'user',
        isSidechain: true,
        message: { role: 'user', content: 'search the repo for the order key' },
      },
    },
    {
      label: 'a background-task notification',
      record: {
        type: 'user',
        message: { role: 'user', content: '<task-notification>build finished</task-notification>' },
      },
    },
    {
      label: 'a DorkOS corrective note (DOR-1087)',
      record: {
        type: 'user',
        message: {
          role: 'user',
          content: '<dorkos-system-note>stay in the worktree</dorkos-system-note>',
        },
      },
    },
    {
      label: 'a local command’s captured output',
      record: {
        type: 'user',
        message: {
          role: 'user',
          content: '<local-command-stdout>3 files changed</local-command-stdout>',
        },
      },
    },
    {
      label: 'a post-compaction summary (isCompactSummary)',
      record: {
        type: 'user',
        isCompactSummary: true,
        message: { role: 'user', content: 'Summary of the conversation so far.' },
      },
    },
    {
      label: 'a legacy compaction summary with no flag',
      record: {
        type: 'user',
        message: {
          role: 'user',
          content: 'This session is being continued from a previous conversation.',
        },
      },
    },
    {
      label: 'a relay hand-off carrying no operator content',
      record: {
        type: 'user',
        message: { role: 'user', content: '<relay_context>from warden</relay_context>' },
      },
    },
    {
      label: 'an injected system reminder and nothing else',
      record: {
        type: 'user',
        message: {
          role: 'user',
          content: '<system-reminder>the file changed on disk</system-reminder>',
        },
      },
    },
    {
      label: 'an assistant turn',
      record: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], model: 'opus' },
      },
    },
  ];

  it.each(notThePerson)('does not count $label', async ({ record }) => {
    await writeTranscript(dir, 'sess-noise', [
      personLine(),
      JSON.stringify({ ...record, timestamp: NOISE_AT }),
    ]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.lastUserMessageAt).toBe(PERSON_WROTE_AT);
  });

  it('counts a relay hand-off’s trailing operator content — the person did write that', async () => {
    await writeTranscript(dir, 'sess-relay', [
      personLine(),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: '<relay_context>from warden</relay_context>\nplease review this',
        },
        timestamp: NOISE_AT,
      }),
    ]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.lastUserMessageAt).toBe(NOISE_AT);
  });

  it('counts a slash command — the person typed it', async () => {
    await writeTranscript(dir, 'sess-command', [
      personLine(),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '<command-name>/flow:verify</command-name>' },
        timestamp: NOISE_AT,
      }),
    ]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.lastUserMessageAt).toBe(NOISE_AT);
  });

  it('omits the field when the person’s message carries no timestamp', async () => {
    // Purpose: omission, never a guess. Dating an undated record from the file's
    // mtime would be `updatedAt` under this field's name.
    await writeTranscript(dir, 'sess-undated', [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello' },
        cwd: '/work/ctx',
      }),
      assistantLine('2026-07-01T09:10:00.000Z'),
    ]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.id).toBe('sess-undated');
    expect(session?.lastUserMessageAt).toBeUndefined();
  });

  it('omits the field when the person’s message has scrolled past the readable tail', async () => {
    // Purpose: the tail read is bounded (16KB) and this is its honest edge. A
    // long agent monologue pushes the person's turn out of the window, and the
    // row then says nothing rather than reporting the newest thing it can see.
    const filler = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'x'.repeat(200) }],
          model: 'opus',
        },
        timestamp: `2026-07-01T09:${String(i % 60).padStart(2, '0')}:00.000Z`,
      })
    );
    await writeTranscript(dir, 'sess-scrolled', [personLine(), ...filler]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.id).toBe('sess-scrolled');
    expect(session?.lastUserMessageAt).toBeUndefined();
  });

  it('getSession reports the same instant as the list row — one tail-read path', async () => {
    const vaultRoot = '/work/gs';
    const slug = reader.getProjectSlug(vaultRoot);
    hoisted.configDir = dir;
    const projectDir = join(dir, 'projects', slug);
    await mkdir(projectDir, { recursive: true });
    await writeTranscript(projectDir, 'sess-gs', [
      personLine('gs'),
      assistantLine('2026-07-01T09:40:00.000Z'),
    ]);

    const session = await reader.getSession(vaultRoot, 'sess-gs');
    expect(session?.lastUserMessageAt).toBe(PERSON_WROTE_AT);
  });
});
