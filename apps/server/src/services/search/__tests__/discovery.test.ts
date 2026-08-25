import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { discoverClaudeCodeTranscripts } from '../claude-code-discovery.js';

/**
 * Discovery's job is to walk a tree that is 87% files nobody said anything in,
 * and to be able to SAY that is what it did.
 *
 * The trap this suite exists for: a one-level glob of `<root>/<slug>/*.jsonl`
 * produces exactly the same indexed set as a correct walk, so a count-only
 * assertion passes for the implementation the spec forbids. Every test here
 * therefore asserts on the reported skipped set — the only observable that
 * differs between having decided against a nested file and never having visited
 * it.
 */

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-search-discovery-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Write a transcript whose head record names `cwd`. */
async function writeTranscript(relative: string, cwd: string | null): Promise<string> {
  const full = path.join(root, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const head = {
    type: 'user',
    ...(cwd === null ? {} : { cwd }),
    message: { role: 'user', content: 'hi' },
  };
  await fs.writeFile(full, `${JSON.stringify(head)}\n`);
  return full;
}

/** The reason discovery recorded for a path, or undefined when it indexed it. */
function reasonFor(
  skipped: { path: string; reason: string }[],
  filePath: string
): string | undefined {
  return skipped.find((entry) => entry.path === filePath)?.reason;
}

describe('discovering Claude Code transcripts', () => {
  it('indexes main sessions and reports a decision for everything else it walked past', async () => {
    const main = await writeTranscript('slug-a/session-1.jsonl', '/repo/project');
    const subagent = await writeTranscript('slug-a/session-1/subagents/x.jsonl', '/repo/project');
    const nested = await writeTranscript(
      'slug-a/session-1/subagents/workflows/wf/y.jsonl',
      '/repo/project'
    );
    const plugin = await writeTranscript('slug-a/vercel-plugin/skill-injections.jsonl', null);
    const evalRun = await writeTranscript(
      'slug-b/session-2.jsonl',
      '/var/folders/t/dorkos-evals-abc123/repo'
    );

    const found = await discoverClaudeCodeTranscripts([root]);

    expect(found.files.map((file) => file.originKey)).toEqual(['session-1']);
    expect(found.files[0]?.filePath).toBe(main);
    expect(found.files[0]?.containerPath).toBe('/repo/project');

    // The whole point: the nested paths were VISITED and decided against. A
    // one-level glob would report an identical `files` array and an empty
    // `skipped` array.
    expect(reasonFor(found.skipped, subagent)).toBe('subagent-transcript');
    expect(reasonFor(found.skipped, nested)).toBe('subagent-transcript');
    expect(reasonFor(found.skipped, plugin)).toBe('plugin-artifact');
    expect(reasonFor(found.skipped, evalRun)).toBe('eval-sandbox');
    expect(found.skipped).toHaveLength(4);
  });

  it('tests the eval sandbox on the head-record cwd, never on the directory slug', async () => {
    // The slug is a lossy `cwd.replace(/[^a-zA-Z0-9-]/g, '-')`, so a real repo
    // path can produce a slug that LOOKS like a sandbox and a sandbox can
    // produce one that does not. Only the cwd is evidence.
    // Slug says sandbox, cwd says real work: INDEXED.
    const lookalike = await writeTranscript(
      '-Users-me-dorkos-evals-9f2-repo/session-3.jsonl',
      '/Users/me/code/repo'
    );
    // Slug says nothing, cwd says sandbox: SKIPPED.
    const sandbox = await writeTranscript(
      '-Users-me-code-repo/session-4.jsonl',
      '/var/folders/xyz/dorkos-evals-9f2/repo'
    );

    const found = await discoverClaudeCodeTranscripts([root]);

    expect(found.files.map((file) => file.filePath)).toEqual([lookalike]);
    expect(reasonFor(found.skipped, sandbox)).toBe('eval-sandbox');
  });

  it('matches a whole path segment, so a repo merely NAMED after the sandbox prefix is indexed', async () => {
    await writeTranscript('slug-c/session-5.jsonl', '/Users/me/code/my-dorkos-evals-harness');

    const found = await discoverClaudeCodeTranscripts([root]);

    expect(found.files.map((file) => file.originKey)).toEqual(['session-5']);
    expect(found.skipped).toEqual([]);
  });

  it('reports a nested file matching no known kind rather than indexing it', async () => {
    // A file nobody has seen yet must land in the skipped set, not in the index
    // under a session id invented from its filename.
    const unknown = await writeTranscript('slug-d/session-6/leftovers/z.jsonl', '/repo');

    const found = await discoverClaudeCodeTranscripts([root]);

    expect(found.files).toEqual([]);
    expect(reasonFor(found.skipped, unknown)).toBe('not-a-main-session');
  });

  it('carries the size and mtime that change detection runs on', async () => {
    const main = await writeTranscript('slug-e/session-7.jsonl', '/repo');
    const stat = await fs.stat(main);

    const found = await discoverClaudeCodeTranscripts([root]);

    expect(found.files[0]?.sizeBytes).toBe(stat.size);
    expect(found.files[0]?.mtimeMs).toBe(stat.mtimeMs);
  });

  it('indexes a transcript that names no working directory, with a null container path', async () => {
    await writeTranscript('slug-f/session-8.jsonl', null);

    const found = await discoverClaudeCodeTranscripts([root]);

    // Absence of a cwd is not evidence of a sandbox: excluding on it would drop
    // real conversations to catch a case that has its own positive test.
    expect(found.files.map((file) => file.originKey)).toEqual(['session-8']);
    expect(found.files[0]?.containerPath).toBeNull();
  });

  it('finds the working directory a few records into the file', async () => {
    // Claude Code opens some transcripts with a `summary` record that carries no
    // cwd, so reading only line 1 would lose the path.
    const full = path.join(root, 'slug-g/session-9.jsonl');
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(
      full,
      [
        JSON.stringify({ type: 'summary', summary: 'A chat' }),
        JSON.stringify({
          type: 'user',
          cwd: '/repo/late',
          message: { role: 'user', content: 'hi' },
        }),
        '',
      ].join('\n')
    );

    const found = await discoverClaudeCodeTranscripts([root]);

    expect(found.files[0]?.containerPath).toBe('/repo/late');
  });

  describe('the head read an unchanged file must not pay for', () => {
    /** A head reader that counts its callers instead of touching the disk. */
    function countingReader(cwd: string | null = '/repo/project') {
      const calls: string[] = [];
      return {
        calls,
        read: async (filePath: string) => {
          calls.push(filePath);
          return cwd;
        },
      };
    }

    it('does not read the head of a file whose size and mtime are unchanged', async () => {
      // The whole cost this branch exists to avoid: up to 64 KiB per
      // main-session file per five-minute tick, ~11 MB on this corpus, charged
      // entirely against files nothing has happened to.
      const file = await writeTranscript('slug-a/session-1.jsonl', '/repo/project');
      const stat = await fs.stat(file);
      const reader = countingReader();

      const found = await discoverClaudeCodeTranscripts(
        [root],
        new Map([
          [
            'session-1',
            { sizeBytes: stat.size, mtimeMs: stat.mtimeMs, containerPath: '/repo/project' },
          ],
        ]),
        reader.read
      );

      expect(reader.calls).toEqual([]);
      // And the file is still discovered, with the path the frontier held.
      expect(found.files.map((entry) => entry.originKey)).toEqual(['session-1']);
      expect(found.files[0]?.containerPath).toBe('/repo/project');
    });

    it('reads the head when the file grew, even by one byte', async () => {
      const file = await writeTranscript('slug-a/session-1.jsonl', '/repo/moved');
      const stat = await fs.stat(file);
      const reader = countingReader('/repo/moved');

      const found = await discoverClaudeCodeTranscripts(
        [root],
        new Map([
          [
            'session-1',
            { sizeBytes: stat.size - 1, mtimeMs: stat.mtimeMs, containerPath: '/repo/stale' },
          ],
        ]),
        reader.read
      );

      expect(reader.calls).toEqual([file]);
      expect(found.files[0]?.containerPath).toBe('/repo/moved');
    });

    it('reads the head of a file the frontier has never seen', async () => {
      // An eval sandbox is exactly this case forever — it never earns a frontier
      // row, so it is re-classified and re-excluded on every sweep.
      const file = await writeTranscript('slug-b/session-2.jsonl', '/tmp/dorkos-evals-abc/repo');
      const reader = countingReader('/tmp/dorkos-evals-abc/repo');

      const found = await discoverClaudeCodeTranscripts([root], new Map(), reader.read);

      expect(reader.calls).toEqual([file]);
      expect(found.files).toEqual([]);
      expect(reasonFor(found.skipped, file)).toBe('eval-sandbox');
    });
  });

  it('is empty and silent on a root Claude Code never wrote', async () => {
    const found = await discoverClaudeCodeTranscripts([path.join(root, 'nowhere', 'projects')]);

    // Silent specifically: an absent root is an account nobody has used, not a
    // failure. Reporting it would light a warning on every machine with fewer
    // accounts registered than directories that once existed.
    expect(found).toEqual({ files: [], skipped: [], failures: [] });
  });
});
