/**
 * Finding the Codex rollout files worth indexing (message-search spec §2.2, §4).
 *
 * A Codex home is far simpler than a Claude Code projects root: one thread is
 * one append-only JSONL file, there are no subagent transcripts nested inside it
 * and no plugin artifacts beside it. Two roots hold them —
 * `$CODEX_HOME/sessions/YYYY/MM/DD/` and the flat `$CODEX_HOME/archived_sessions/`
 * — and both are read, because archiving a thread does not unsay what was said.
 * Measured on this machine 2026-08-25: **18 rollout files, 7.0 MB, 2,200 lines,
 * zero malformed**, 14 live and 4 archived.
 *
 * **The container id comes from the FILENAME, not from the file's head record,
 * and the difference is a sweep's worth of reads.** Spec §4 defines Codex's
 * `origin_key` as "the session id from `session_meta`" — and the CLI writes that
 * same id into the filename it chooses: `rollout-<ISO>-<sessionId>.jsonl`.
 * Measured over all 18 files, the two agree **18 of 18 times**. Taking it from
 * the name is what lets an unchanged file cost one `stat` and nothing else: a
 * frontier keyed by an id that only the file's bytes carry could not be
 * consulted before reading those bytes, so every rollout would be head-read on
 * every five-minute tick forever. A file whose name does not carry an id is
 * reported as {@link SkipReason} `not-a-rollout` rather than indexed under
 * something invented.
 *
 * **The working directory still comes from the head record**, because nothing
 * else has it: `session_meta.payload.cwd`, present on 18 of 18 files. That read
 * is skipped for a file whose `(size, mtime)` the frontier already recorded,
 * exactly as Claude Code's is.
 *
 * @module server/services/search/codex-discovery
 */
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../lib/logger.js';
import { collapseRoots, walkJsonlFiles } from './jsonl-walk.js';
import type {
  DiscoveryFailure,
  FileContainer,
  FileDiscovery,
  KnownContainer,
  SkippedFile,
} from './types.js';

/**
 * The rollout filename, and the session id inside it.
 *
 * `rollout-2026-08-08T10-32-17-019fe200-e5e8-7d23-9e68-3a32dd78cf8a.jsonl`: a
 * fixed prefix, the thread's start time with `:` swapped for `-` because a colon
 * is not a filename on every filesystem, then the session id. The timestamp is
 * matched rather than skipped over so the id cannot start halfway through a date
 * on a file whose name only resembles a rollout.
 */
const ROLLOUT_FILENAME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;

/**
 * How far into a rollout to look for the working directory.
 *
 * Deliberately larger than Claude Code's 64 KiB. A Codex `session_meta` record
 * carries `base_instructions` — the whole system prompt of the CLI release that
 * wrote it — so line 1 is big and grows with the product: the largest measured
 * on this machine is **34,956 bytes**, and the largest line of any kind is
 * 62,573. 256 KiB is seven times the largest head observed.
 *
 * **And when a head outgrows it anyway, that is said out loud.** A window the
 * head record exceeds does not fail: the scan simply finds no `cwd` and the
 * session indexes with none, so every one of its hits opens nowhere while the
 * search results look perfectly healthy — the quiet shortfall this whole
 * feature exists to refuse. The two cases are distinguishable, so they are
 * distinguished: a file that filled the window without naming a directory is
 * warned about by path ({@link readSessionMetaCwd}), while one that honestly
 * names none is silent. The file is still INDEXED either way — its messages are
 * what search is for, and dropping a whole conversation to protect against an
 * unknown directory would be the larger loss.
 */
const HEAD_SCAN_BYTES = 256 * 1024;

/** How discovery reads a rollout's head. Swapped only by a test, which counts the calls. */
export type CodexHeadCwdReader = (filePath: string) => Promise<string | null>;

/**
 * Every rollout under these roots that should be indexed, every file that should
 * not, and every root that could not be read.
 *
 * The two roots are one corpus: a thread the operator archived is the same
 * thread it was before, and a person searching their own history is precisely
 * the reader who has forgotten which state it is in. They are walked in order —
 * live sessions first — and their results concatenated.
 *
 * **Two files claiming one session id are refused downstream, both of them**
 * (`jsonl-frontier.ts`), and Codex is where that stops being hypothetical for a
 * reason Claude Code does not have: archiving is a file MOVE today, so a release
 * that started copying instead would put every archived thread's id in two
 * places at once. Refusing both is right and the failure is loud; preferring one
 * root would silently pick a winner nobody chose.
 *
 * A root that does not exist yields nothing and no error — Codex may simply
 * never have run here, and on a machine with no `~/.codex` at all this source
 * contributes zero rows and zero warnings. A root that EXISTS and cannot be
 * enumerated is reported, because then the corpus is incomplete by an unknown
 * amount, which is the failure this feature refuses.
 *
 * @param rolloutRoots - `sessions/` and `archived_sessions/`, in sweep order.
 * @param known - What the frontier already holds, keyed by container id. A file
 *   whose `(size, mtime)` match an entry here has not changed since the last
 *   sweep, so its working directory comes from there instead of from a fresh
 *   head read.
 * @param readCwd - How to read a rollout's head. Present so a test can prove the
 *   read is skipped; production never passes it.
 * @returns The files to index, the decisions taken against the rest, and the
 *   roots that could not be read.
 */
export async function discoverCodexRollouts(
  rolloutRoots: readonly string[],
  known: ReadonlyMap<string, KnownContainer> = new Map(),
  readCwd: CodexHeadCwdReader = readSessionMetaCwd
): Promise<FileDiscovery> {
  const files: FileContainer[] = [];
  const skipped: SkippedFile[] = [];
  const failures: DiscoveryFailure[] = [];

  for (const root of await collapseRoots(rolloutRoots)) {
    const walked = await walkJsonlFiles(root);
    if (walked.failure !== null) failures.push({ root, message: walked.failure });

    for (const candidate of walked.files) {
      const decision = await classifyRollout(candidate.filePath, known, readCwd);
      if (decision === null) continue;
      if ('reason' in decision) skipped.push(decision);
      else files.push(decision);
    }
  }

  return { files, skipped, failures };
}

/**
 * Decide what one walked file is: a rollout to index, a decision to report, or
 * nothing at all.
 *
 * The third answer is the same one Claude Code's classifier gives: a file that
 * cannot be `stat`ed is not a decision anybody made — it went away between the
 * `readdir` and the `stat`, or this process may not reach it — so it belongs in
 * neither list.
 *
 * @param filePath - The file the walk found.
 * @param known - What the frontier holds, keyed by container id.
 * @param readCwd - How to read a rollout's head.
 * @returns The container, the skip decision, or `null` when the file went away.
 */
async function classifyRollout(
  filePath: string,
  known: ReadonlyMap<string, KnownContainer>,
  readCwd: CodexHeadCwdReader
): Promise<FileContainer | SkippedFile | null> {
  const originKey = ROLLOUT_FILENAME.exec(path.basename(filePath))?.[1];
  if (originKey === undefined || originKey === '') {
    // A `.jsonl` in a rollout root that is not named like one is reported rather
    // than indexed under a made-up id: `$CODEX_HOME` holds other newline-
    // delimited files (`session_index.jsonl`, for one), and a kind nobody has
    // seen yet should show up in the skipped set rather than in the index.
    return { path: filePath, reason: 'not-a-rollout' };
  }

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }

  const container: FileContainer = {
    originKey,
    filePath,
    containerPath: null,
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
  };

  const settled = known.get(originKey);
  if (
    settled !== undefined &&
    settled.sizeBytes === stat.size &&
    settled.mtimeMs === stat.mtimeMs
  ) {
    return { ...container, containerPath: settled.containerPath };
  }

  return { ...container, containerPath: await readCwd(filePath) };
}

/**
 * The working directory a rollout's head records name, or `null` when its
 * opening chunk names none.
 *
 * `session_meta` is line 1 of every rollout measured (18 of 18) and carries
 * `payload.cwd`. The scan does not insist on that: it takes the first record
 * whose `payload.cwd` is a non-empty string, so a rollout whose meta record ever
 * stops carrying one still gets a path from the `turn_context` record that
 * follows it, which carries the same field per turn.
 *
 * **Finding nothing in a window that FILLED is reported.** See
 * {@link HEAD_SCAN_BYTES}: "no directory in the first 256 KiB" and "this
 * conversation names no directory" produce the same `null` and mean opposite
 * things, and only the first is a fault anybody can fix. It is a log line rather
 * than a `DiscoveryFailure` on purpose — a failure suppresses the prune for the
 * whole source, and a head that is too big stays too big, so it would freeze
 * pruning forever over a container path.
 *
 * Splits on `\n` alone, for the reason `jsonl-frontier.ts` documents at length.
 *
 * @param filePath - The rollout to read.
 * @returns The working directory, or `null`.
 */
async function readSessionMetaCwd(filePath: string): Promise<string | null> {
  let head: string;
  let truncated: boolean;
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(HEAD_SCAN_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_SCAN_BYTES, 0);
      head = buffer.subarray(0, bytesRead).toString('utf8');
      truncated = bytesRead === HEAD_SCAN_BYTES;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }

  const lines = head.split('\n');
  // Only when the window filled: the last fragment is then a line cut in half,
  // and parsing half a record would be reading a truncated `cwd`.
  if (truncated) lines.pop();

  for (const line of lines) {
    if (line.trim() === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = (record as { payload?: unknown } | null)?.payload;
    if (payload === null || typeof payload !== 'object') continue;
    const cwd = (payload as { cwd?: unknown }).cwd;
    if (typeof cwd === 'string' && cwd !== '') return cwd;
  }

  if (truncated) {
    logger.warn(
      '[search] a codex rollout named no working directory in the bytes scanned; ' +
        'its hits will open nowhere',
      { filePath, scannedBytes: HEAD_SCAN_BYTES }
    );
  }
  return null;
}
