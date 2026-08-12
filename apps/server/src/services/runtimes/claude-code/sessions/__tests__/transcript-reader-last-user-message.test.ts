/**
 * `Session.userLastMessageAt` — when the PERSON last wrote (BC-16).
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
import { TRANSCRIPT } from '../../../../../config/constants.js';

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

/**
 * A `<relay_context>` record's raw text, with the `From:` line that decides
 * whether a person or a machine published it, and optional trailing content.
 */
function relayBlock(from: string, trailing?: string): string {
  return `<relay_context>\nFrom: ${from}\n</relay_context>${trailing ? `\n${trailing}` : ''}`;
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
    expect(session?.userLastMessageAt).toBe(PERSON_WROTE_AT);
    expect(session?.updatedAt).toBe(MTIME.toISOString());
    expect(Date.parse(session!.userLastMessageAt!)).toBeLessThan(Date.parse(session!.updatedAt));
  });

  it('takes the LAST of several messages from the person', async () => {
    await writeTranscript(dir, 'sess-many', [
      personLine('first'),
      assistantLine('2026-07-01T09:05:00.000Z'),
      personLine('and another thing', '2026-07-01T09:20:00.000Z'),
      assistantLine('2026-07-01T09:50:00.000Z'),
    ]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.userLastMessageAt).toBe('2026-07-01T09:20:00.000Z');
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
      label: 'a relay hand-off from another AGENT, even with content trailing it',
      record: {
        type: 'user',
        message: { role: 'user', content: relayBlock('relay.agent.warden', 'please review this') },
      },
    },
    {
      label: 'a relay hand-off from a scheduled task',
      record: {
        type: 'user',
        message: {
          role: 'user',
          content: relayBlock('relay.system.tasks.nightly', 'run the digest'),
        },
      },
    },
    {
      label: 'a relay hand-off from an A2A client',
      record: {
        type: 'user',
        message: { role: 'user', content: relayBlock('a2a-gateway', 'do the thing') },
      },
    },
    {
      label: 'a relay hand-off from a person carrying no content of their own',
      record: {
        type: 'user',
        message: { role: 'user', content: relayBlock('relay.human.console') },
      },
    },
    {
      label: 'bash-mode stdout',
      record: {
        type: 'user',
        message: { role: 'user', content: '<bash-stdout>3 files changed</bash-stdout>' },
      },
    },
    {
      label: 'bash-mode stderr',
      record: {
        type: 'user',
        message: { role: 'user', content: '<bash-stderr>command not found</bash-stderr>' },
      },
    },
    {
      // N6's insurance: the array content shape carries none of these wrappers
      // in any transcript observed so far, so this pins the guard in the branch
      // that would otherwise let one through if the SDK ever moved it.
      label: 'a task notification arriving in the array content shape',
      record: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<task-notification>build finished</task-notification>' },
          ],
        },
      },
    },
    {
      label: 'an agent relay hand-off arriving in the array content shape',
      record: {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: relayBlock('relay.agent.warden', 'take a look') }],
        },
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
    expect(session?.userLastMessageAt).toBe(PERSON_WROTE_AT);
  });

  // The paired positive to the agent-`From:` rows above. Relay is the same
  // wrapper either way, so the ONLY thing separating these two cases is the
  // `From:` line — which is exactly what makes the gate load-bearing rather
  // than a blanket "relay never counts".
  it.each([
    { label: 'the operator’s own console', from: 'relay.human.console' },
    { label: 'a suffixed console principal', from: 'relay.human.console.inferred' },
    { label: 'a person writing from Telegram', from: 'relay.human.telegram.chat42' },
  ])('counts a relay hand-off from $label', async ({ from }) => {
    await writeTranscript(dir, 'sess-relay', [
      personLine(),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: relayBlock(from, 'please review this') },
        timestamp: NOISE_AT,
      }),
    ]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.userLastMessageAt).toBe(NOISE_AT);
  });

  it('counts a bash-mode command the person typed', async () => {
    // The paired positive to bash-stdout/bash-stderr: the input is theirs, the
    // output is the machine's.
    await writeTranscript(dir, 'sess-bash', [
      personLine(),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '<bash-input>git status</bash-input>' },
        timestamp: NOISE_AT,
      }),
    ]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.userLastMessageAt).toBe(NOISE_AT);
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
    expect(session?.userLastMessageAt).toBe(NOISE_AT);
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
    expect(session?.userLastMessageAt).toBeUndefined();
  });

  it('omits the field when the person’s message has scrolled past the readable tail', async () => {
    // Purpose: the tail read is bounded and this is its honest edge. A long
    // agent monologue pushes the person's turn out of the window, and the row
    // then says nothing rather than reporting the newest thing it can see.
    //
    // The filler is sized off TAIL_BUFFER_BYTES rather than a literal, so
    // widening the window (16 KB → 64 KB for BC-16) moves this case with it
    // instead of silently turning it green for the wrong reason.
    const line = (i: number) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'x'.repeat(400) }],
          model: 'opus',
        },
        timestamp: `2026-07-01T09:${String(i % 60).padStart(2, '0')}:00.000Z`,
      });
    const filler: string[] = [];
    let bytes = 0;
    for (let i = 0; bytes <= TRANSCRIPT.TAIL_BUFFER_BYTES; i++) {
      const next = line(i);
      filler.push(next);
      bytes += next.length + 1;
    }
    await writeTranscript(dir, 'sess-scrolled', [personLine(), ...filler]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.id).toBe('sess-scrolled');
    expect(session?.userLastMessageAt).toBeUndefined();
  });

  it('reaches back a whole agent work session — the 64 KB window is the point', async () => {
    // Purpose: the paired positive to the case above, and the reason the window
    // grew. Measured over 474 real transcripts the person's last turn sits a
    // median of 27 KB back, so 16 KB answered ~11% of conversations; this
    // fixture puts it beyond the old window and inside the new one.
    const line = (i: number) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'x'.repeat(400) }],
          model: 'opus',
        },
        timestamp: `2026-07-01T09:${String(i % 60).padStart(2, '0')}:00.000Z`,
      });
    const filler: string[] = [];
    let bytes = 0;
    // Comfortably past 16 KB, comfortably inside 64 KB.
    while (bytes < 24_000) {
      const next = line(filler.length);
      filler.push(next);
      bytes += next.length + 1;
    }
    expect(bytes).toBeLessThan(TRANSCRIPT.TAIL_BUFFER_BYTES);
    await writeTranscript(dir, 'sess-deep', [personLine(), ...filler]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.userLastMessageAt).toBe(PERSON_WROTE_AT);
  });

  // The session-level gate, the half no content rule can do. A scheduled run's
  // prompt and an agent hand-off's payload reach the transcript as ordinary
  // user text; only the session's own origin knows better.
  describe('a session nobody typed in reports nothing at all', () => {
    it('omits the field for a scheduled task, however many user records it holds', async () => {
      // Purpose: this is the churn BC-16 exists to prevent — a cron task firing
      // every hour would otherwise bump the sidebar's order key with nobody
      // present. Every record here would count on its own merits.
      await writeTranscript(dir, 'sess-task', [
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: '=== TASK SCHEDULER CONTEXT ===\nRun the nightly digest.',
          },
          timestamp: PERSON_WROTE_AT,
          cwd: '/work/ctx',
        }),
        assistantLine('2026-07-01T09:05:00.000Z'),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'and now post the summary' },
          timestamp: NOISE_AT,
        }),
        assistantLine('2026-07-01T09:40:00.000Z'),
      ]);

      const [session] = await reader.listSessionsInDir(dir);
      expect(session?.origin).toBe('task');
      expect(session?.userLastMessageAt).toBeUndefined();
    });

    it('omits the field for a session another agent started', async () => {
      await writeTranscript(dir, 'sess-agent', [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: relayBlock('relay.agent.warden', 'take this over') },
          timestamp: PERSON_WROTE_AT,
          cwd: '/work/ctx',
        }),
        assistantLine('2026-07-01T09:05:00.000Z'),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'keep going' },
          timestamp: NOISE_AT,
        }),
        assistantLine('2026-07-01T09:40:00.000Z'),
      ]);

      const [session] = await reader.listSessionsInDir(dir);
      expect(session?.origin).toBe('agent');
      expect(session?.userLastMessageAt).toBeUndefined();
    });

    it('still reports for a session a person started from a bridged chat', async () => {
      // The paired positive: `channel` is NOT in the gate, because a message
      // from Telegram is a person writing.
      await writeTranscript(dir, 'sess-channel', [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: relayBlock('relay.human.telegram', 'ship it') },
          timestamp: PERSON_WROTE_AT,
          cwd: '/work/ctx',
        }),
        assistantLine('2026-07-01T09:40:00.000Z'),
      ]);

      const [session] = await reader.listSessionsInDir(dir);
      expect(session?.origin).toBe('channel');
      expect(session?.userLastMessageAt).toBe(PERSON_WROTE_AT);
    });
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
    expect(session?.userLastMessageAt).toBe(PERSON_WROTE_AT);
  });
});
