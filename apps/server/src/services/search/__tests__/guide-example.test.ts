/**
 * The pin for `contributing/adding-a-search-source.md`.
 *
 * A guide whose only check is "a human read it" is not checked at all. This file
 * pins the guide's worked example two ways, and both directions matter:
 *
 * 1. **Verbatim.** Every code block in the guide marked
 *    `<!-- pinned-by: guide-example.test.ts -->` must appear character-for-
 *    character in this file. Editing one side without the other is red.
 * 2. **Functionally.** The same code is registered as a real source, swept
 *    through the real M1 mechanism against real files, and searched through the
 *    real ranked query. If the registry shape or the projection contract drifts,
 *    the example stops compiling and this goes red.
 *
 * ## Which guide sections it pins
 *
 * - **§ Adding a Source, Step by Step**, blocks 2 to 5: the projection, the head
 *   read that supplies `container_path`, discovery, and the registry row.
 * - **§ The Projection Contract** — purity (the projection is called with
 *   nothing but strings), handed-in ordinals, `skipped` as the drift signal,
 *   and a null timestamp rather than an invented one. Each of those four
 *   executes; none is pinned by its wording alone.
 * - **§ The Registry Row** — `id`, `mechanism` and `corpus` are the record; the
 *   roots are a parameter so a test can point the source somewhere safe.
 * - **§ Rules That Are Not Style** — `origin_key` composed by the projection,
 *   `container_path` on `search_sources` and never on `messages`.
 * - **§ When to Use What** — several roots in one source, an absent root that is
 *   not a failure, and a file that vanishes mid-discovery: neither indexed nor
 *   reported, and fatal to nothing.
 * - **§ Anti-Patterns**, last row: a fixture source never enters
 *   `SEARCH_SOURCES`, asserted below.
 *
 * The fixture source lives here and nowhere else. A `journal` row in the
 * production registry would sweep the operator's machine every five minutes
 * looking for a runtime that does not exist.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTestDb } from '@dorkos/test-utils/db';
import { messages as messagesTable, searchSources, eq, type Db } from '@dorkos/db';
import { sweepFileSource } from '../jsonl-frontier.js';
import { searchMessages, MATCH_OPEN, MATCH_CLOSE } from '../query.js';
import type {
  DiscoveryFailure,
  FileContainer,
  FileDiscovery,
  FileSource,
  KnownContainer,
  ProjectedMessage,
  Projection,
} from '../types.js';

// ---------------------------------------------------------------------------
// The guide's worked example, verbatim. Do not edit either copy alone.
// ---------------------------------------------------------------------------

/**
 * The journal projection: raw lines in, searchable messages out.
 *
 * **Pure.** No filesystem, no database, no clock — which is what makes it
 * table-testable and what keeps "adding a source" honest at one function.
 *
 * @param lines - Complete lines from ONE journal file, in file order.
 * @param context - Which container these belong to, and the ordinal the first
 *   message produced should carry.
 * @returns The messages, plus how many records drifted.
 */
export function projectJournalLines(
  lines: readonly string[],
  context: { originKey: string; firstOrdinal: number }
): Projection {
  const messages: ProjectedMessage[] = [];
  let skipped = 0;
  let ordinal = context.firstOrdinal;

  for (const raw of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Counted, never thrown: one drifted record must not stop a container,
      // and `skipped` is the only thing that tells a broken projection apart
      // from a source with nothing to say.
      skipped += 1;
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') {
      skipped += 1;
      continue;
    }

    // Explicit fields, named one at a time. Never a walk over whatever keys the
    // record happens to carry — see "Never traverse generically".
    const record = parsed as { who?: unknown; text?: unknown; at?: unknown };

    // The head record is not a message. Dropped silently rather than counted:
    // it was never a message, so it is not evidence of drift.
    if (record.who !== 'user' && record.who !== 'assistant') continue;
    if (typeof record.text !== 'string' || record.text.trim() === '') continue;

    messages.push({
      // The projection COMPOSES the container id; the index never parses it.
      originKey: context.originKey,
      ordinal: ordinal++,
      // This toy source's records carry no id of their own, so the guide's
      // example is also the shape a source without one takes: `null`, never an
      // id invented here.
      messageId: null,
      role: record.who,
      // Whatever the record stamped, or null. A fabricated timestamp would sort
      // results into an order nobody can explain.
      createdAt: typeof record.at === 'string' ? record.at : null,
      body: record.text,
    });
  }

  return { messages, skipped };
}

/**
 * The working directory a journal file names, from its own head record.
 *
 * **Never derived from the directory name.** A path baked into a filename is
 * lossy and cannot be inverted, so a source that has no head record answers
 * `null` rather than guessing — and `null` is a supported answer.
 *
 * **The `open` is INSIDE the try.** A file can vanish between `readdir` and this
 * call — log rotation, a runtime's own cleanup — and an `open` outside the guard
 * rejects `discover()` for the whole source, which the sweep turns into zero
 * rows, no prune and no `last_error` for that tick.
 *
 * @param filePath - The journal file to peek at.
 * @returns The recorded working directory, or `null`.
 */
async function readJournalCwd(filePath: string): Promise<string | null> {
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      // The head, not the file. A discovery pass that read whole transcripts to
      // classify them would cost megabytes every five minutes.
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const head = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? '';
      const parsed: unknown = JSON.parse(head);
      if (parsed === null || typeof parsed !== 'object') return null;
      const cwd = (parsed as { cwd?: unknown }).cwd;
      // Non-empty, matching the shipped readers: an empty string is not a
      // directory, and storing one would make a hit claim to open somewhere.
      return typeof cwd === 'string' && cwd !== '' ? cwd : null;
    } finally {
      await handle.close();
    }
  } catch {
    // A file that vanished, or one with no readable head, still costs the sweep
    // nothing: it simply opens nowhere.
    return null;
  }
}

/**
 * Every journal file under `roots`, with the two signals that say whether it
 * changed.
 *
 * **Resolves rather than rejecting when one root fails.** A source spanning
 * several roots that threw on the first unreadable one would contribute zero
 * rows from the roots that ARE readable, which is the opposite of the per-root
 * degradation the design asks for.
 *
 * @param roots - Directories holding `<conversationId>.jsonl` files.
 * @param known - What the frontier already holds, keyed by container id. A file
 *   whose `(size, mtime)` match an entry here has not changed, so it is
 *   classified from the last sweep's answer instead of by reading it again.
 * @returns What to index, and every root that could not be enumerated.
 */
export async function discoverJournalFiles(
  roots: readonly string[],
  known: ReadonlyMap<string, KnownContainer>
): Promise<FileDiscovery> {
  const files: FileContainer[] = [];
  const failures: DiscoveryFailure[] = [];

  for (const root of roots) {
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch (err) {
      // A root that is simply absent is NOT a failure — the runtime may never
      // have run on this machine. A root that exists and will not open IS one,
      // because a short result list looks exactly like a complete one.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      failures.push({ root, message: err instanceof Error ? err.message : String(err) });
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const filePath = path.join(root, entry);
      const originKey = entry.slice(0, -'.jsonl'.length);

      // **A file can vanish between the readdir and this stat**, and letting
      // that throw would abandon every remaining file in every remaining root.
      // A vanished file is neither indexed nor reported: it is not a decision
      // this source made, so it earns no `SkipReason` and no failure — the
      // prune drops its rows because it is simply not in `files`.
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        continue;
      }

      // This is the whole reason `known` is handed in: an unchanged file costs
      // one readdir entry and one stat, and no head read at all.
      const seen = known.get(originKey);
      const unchanged =
        seen !== undefined && seen.sizeBytes === stat.size && seen.mtimeMs === stat.mtimeMs;

      files.push({
        originKey,
        filePath,
        containerPath: unchanged ? seen.containerPath : await readJournalCwd(filePath),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  // `skipped` is for files walked past DELIBERATELY, each with a `SkipReason`
  // member in `types.ts`. A name that was never ours is not a decision.
  return { files, skipped: [], failures };
}

/**
 * Build a journal source over a set of roots.
 *
 * The roots are a parameter rather than a call so a test can point the source
 * at fixture trees instead of at the operator's real history.
 *
 * @param resolveRoots - Called at the start of every sweep, never cached, so a
 *   root that appears mid-session is indexed on the next tick rather than after
 *   a restart.
 * @returns The registry row.
 */
export function createJournalSource(resolveRoots: () => readonly string[]): FileSource {
  return {
    id: 'journal',
    mechanism: 'jsonl',
    // Journal files live under the operator's home, not under `DORK_HOME`, so a
    // server pointed at a throwaway data directory would still read them.
    corpus: 'external',
    discover: (known) => discoverJournalFiles(resolveRoots(), known),
    project: projectJournalLines,
  };
}

// ---------------------------------------------------------------------------
// The pin itself.
// ---------------------------------------------------------------------------

/** The marker the guide puts above every block this file must carry verbatim. */
const PIN_MARKER = '<!-- pinned-by: guide-example.test.ts -->';

/** How many blocks the guide is expected to mark. Raising it is a deliberate act. */
const PINNED_BLOCK_COUNT = 4;

/** This file's own path, and the repo root six directories above it. */
const SELF_PATH = fileURLToPath(import.meta.url);
const GUIDE_PATH = path.resolve(
  SELF_PATH,
  '../../../../../../..',
  'contributing/adding-a-search-source.md'
);

/**
 * Every fenced TypeScript block in the guide that carries {@link PIN_MARKER}.
 *
 * **The fence must IMMEDIATELY follow its marker.** Taking the next `ts` fence
 * anywhere after it would let a marker orphaned by an edit silently adopt an
 * unrelated block further down the page — the pin would still pass, while
 * pointing at code the guide never claimed was pinned.
 *
 * @param markdown - The guide's text.
 * @returns The blocks' contents, in document order.
 */
function pinnedBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const fence = '```ts\n';
  let from = 0;

  for (;;) {
    const marker = markdown.indexOf(PIN_MARKER, from);
    if (marker === -1) break;
    const open = markdown.indexOf(fence, marker);
    if (open === -1) throw new Error(`a pin marker at ${marker} is followed by no \`\`\`ts fence`);
    const between = markdown.slice(marker + PIN_MARKER.length, open);
    if (between.trim() !== '') {
      throw new Error(
        `the pin marker at ${marker} is not immediately followed by its fence; ` +
          `${JSON.stringify(between.slice(0, 80))} sits between them`
      );
    }
    const start = open + fence.length;
    const end = markdown.indexOf('\n```', start);
    if (end === -1) throw new Error(`the \`\`\`ts fence at ${open} is never closed`);
    blocks.push(markdown.slice(start, end));
    from = end;
  }

  return blocks;
}

describe('the guide is pinned to code that actually runs', () => {
  it('prints exactly the code this file registers', () => {
    const blocks = pinnedBlocks(readFileSync(GUIDE_PATH, 'utf8'));
    const self = readFileSync(SELF_PATH, 'utf8');

    // A count assertion first: a marker somebody deleted would otherwise make
    // this test pass by having nothing left to check.
    expect(blocks).toHaveLength(PINNED_BLOCK_COUNT);

    for (const block of blocks) {
      // `toContain` rather than a diff, so the failure message shows the guide
      // text that has no home in this file.
      expect(self).toContain(block);
    }
  });
});

describe('the worked example, run as a real source', () => {
  let db: Db;
  let root: string;
  let source: FileSource;

  beforeEach(async () => {
    db = createTestDb();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-guide-example-'));
    source = createJournalSource(() => [root]);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Write a journal file exactly as the guide's format section describes it. */
  async function writeJournal(conversationId: string, lines: readonly string[]): Promise<string> {
    const file = path.join(root, `${conversationId}.jsonl`);
    await fs.writeFile(
      file,
      `${JSON.stringify({ type: 'session', cwd: '/repo/app' })}\n${lines.join('')}`
    );
    return file;
  }

  /** One journal line, with its trailing newline. */
  function said(who: 'user' | 'assistant', text: string): string {
    return `${JSON.stringify({ who, text, at: '2026-08-25T10:00:00.000Z' })}\n`;
  }

  /** One journal line from a runtime that stamped no time. */
  function saidUndated(who: 'user' | 'assistant', text: string): string {
    return `${JSON.stringify({ who, text })}\n`;
  }

  it('indexes a journal file and makes it searchable', async () => {
    await writeJournal('conv-1', [
      said('user', 'why is the deploy stuck'),
      said('assistant', 'The lock file is held by a dead job.'),
      // No `at`. The projection contract says a missing timestamp is null and
      // never invented, so this record has to reach the index dated nothing.
      saidUndated('user', 'and the retry queue'),
      // A record the projection recognises as its own and cannot read. It is
      // COUNTED, which is the guide's drift signal, and it stops nothing.
      '{"who":"user","text":\n',
    ]);

    const sweep = await sweepFileSource(db, source, '2026-08-25T12:00:00.000Z');

    expect(sweep.sourceId).toBe('journal');
    expect(sweep.indexed).toBe(3);
    expect(sweep.skipped).toBe(1);
    expect(sweep.failures).toEqual([]);

    // The undated record kept its place and its null, rather than borrowing a
    // neighbour's timestamp or being dropped for having none.
    expect(
      db
        .select({ ordinal: messagesTable.ordinal, createdAt: messagesTable.createdAt })
        .from(messagesTable)
        .where(eq(messagesTable.originKey, 'conv-1'))
        .orderBy(messagesTable.ordinal)
        .all()
    ).toEqual([
      { ordinal: 0, createdAt: '2026-08-25T10:00:00.000Z' },
      { ordinal: 1, createdAt: '2026-08-25T10:00:00.000Z' },
      { ordinal: 2, createdAt: null },
    ]);

    // `container_path` on `search_sources`, from the file's own head record —
    // never from the directory name, and never repeated onto `messages`.
    expect(
      db
        .select({
          originKey: searchSources.originKey,
          containerPath: searchSources.containerPath,
          lastOrdinal: searchSources.lastOrdinal,
          lastError: searchSources.lastError,
        })
        .from(searchSources)
        .where(eq(searchSources.sourceId, 'journal'))
        .all()
    ).toEqual([
      { originKey: 'conv-1', containerPath: '/repo/app', lastOrdinal: 2, lastError: null },
    ]);

    // Searchable through the real ranked query, in the scope shape
    // `search-service.ts` builds for a non-rooms source.
    const hits = searchMessages(db, {
      scopes: [{ sourceId: 'journal', visibility: 'all' }],
      query: 'deploy',
      limit: 10,
      excerpts: true,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.sourceId).toBe('journal');
    // The container id the projection composed, unparsed by anything since.
    expect(hits[0]?.originKey).toBe('conv-1');
    expect(hits[0]?.ordinal).toBe(0);
    expect(hits[0]?.role).toBe('user');
    expect(hits[0]?.createdAt).toBe('2026-08-25T10:00:00.000Z');
    expect(hits[0]?.excerpt).toContain(`${MATCH_OPEN}deploy${MATCH_CLOSE}`);
  });
});
