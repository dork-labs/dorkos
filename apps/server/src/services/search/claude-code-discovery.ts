/**
 * Finding the Claude Code transcripts worth indexing — and deciding, on the
 * record, against the ones that are not (message-search spec §2.1,
 * Amendment 2).
 *
 * A projects root is not flat. On the operator's machine one holds 241 main
 * sessions and 2,217 other `.jsonl` files: subagent transcripts nested as deep
 * as `<sessionId>/subagents/workflows/<wf>/`, eval-harness sandboxes, and plugin
 * artifacts. **Discovery walks the whole tree** rather than globbing one level
 * below the root, because a one-level glob excludes the subagents by an
 * accident of depth rather than by a decision anyone made — and the day somebody
 * wants them, the change has to be a predicate rather than a rewrite. That is
 * also why every exclusion is reported: the two implementations produce an
 * identical indexed count, and the skipped set is the only thing that tells them
 * apart.
 *
 * **And there is more than one root.** An operator running one Claude Code
 * account per client runs one config directory per account, and all of them hold
 * history somebody will search for. Reading only the active one covered at most
 * 67% of this machine's Claude Code corpus when it was measured, and 3.5% when
 * the server inherited a minor root from its shell — while reporting nothing
 * wrong, because a short result list is indistinguishable from a complete one.
 * `registry.ts` carries the dated figures. Which roots exist is
 * `resolveClaudeRootSet()`'s question, decided once for the whole server; this
 * module's job is to walk however many it is handed as one corpus.
 *
 * @module server/services/search/claude-code-discovery
 */
import fs from 'fs/promises';
import path from 'path';
import { collapseRoots, walkJsonlFiles, type WalkedFile } from './jsonl-walk.js';
import type {
  DiscoveryFailure,
  FileContainer,
  FileDiscovery,
  KnownContainer,
  SkippedFile,
} from './types.js';

/**
 * Directory name marking a subagent's own transcripts.
 *
 * They are 87% of the files and 76% of the bytes, and they are excluded because
 * they are conversations the human never had — an agent's working notes, in
 * which the "user" turn is another agent's prompt. The user story is "every
 * message you have ever sent or received", and neither applies. The shipped
 * adapter already drops sidechain transcripts at list level, so this follows
 * precedent rather than inventing a rule.
 */
const SUBAGENTS_DIR = 'subagents';

/** Directory name holding the Vercel plugin's skill-injection log — harness plumbing, not speech. */
const PLUGIN_ARTIFACT_DIR = 'vercel-plugin';

/**
 * The eval runner's sandbox prefix — the repo's own constant, not a heuristic.
 *
 * `pnpm evals:local` creates its throwaway directory as
 * `mkdtemp(path.join(tmpdir(), SANDBOX_PREFIX))` with
 * `SANDBOX_PREFIX = 'dorkos-evals-'` (`packages/evals/src/runner/sandbox.ts`),
 * then `realpath`s it. Those runs write transcripts into the operator's own
 * projects root like any other session — machine-generated conversations with a
 * model, in a directory that no longer exists. By the same test that excludes
 * subagent transcripts they are the same category, and a box promising "every
 * message *you* have ever sent or received" must not return them.
 */
const EVAL_SANDBOX_PREFIX = 'dorkos-evals-';

/**
 * How far into a transcript to look for the working directory.
 *
 * The head record carries it in practice; a session that has not named one
 * inside its first chunk indexes with no container path rather than paying a
 * whole-file read on every sweep. 64 KiB is two orders of magnitude past the
 * first record of every transcript measured.
 */
const HEAD_SCAN_BYTES = 64 * 1024;

/** How discovery reads a transcript's head. Swapped only by a test, which counts the calls. */
export type HeadCwdReader = (filePath: string) => Promise<string | null>;

/**
 * Every transcript under these projects roots that should be indexed, every one
 * that should not, and every root that could not be read.
 *
 * **The roots are one corpus, not several.** They are walked in order and their
 * results concatenated, because a session id identifies a conversation and
 * nothing about which account it was had under. Two files claiming one session
 * id is therefore a real possibility once several roots are in play — a copied
 * config directory, or one root symlinked into another — and it is refused
 * downstream in `jsonl-frontier.ts` rather than resolved by preferring a root,
 * since preferring one would silently pick a winner nobody chose.
 *
 * **The same directory named twice is one root, and "the same" means the same
 * inode.** Roots normally arrive already deduplicated from
 * `resolveClaudeRootSet()`, but that dedupe is lexical, and a registered account
 * that is a SYMLINK to another root survives it: two different spellings, one
 * directory, every file its own twin, and — since twins are refused, never
 * preferred — an index of nothing at all, rebuilt as nothing every five minutes.
 * That is a total blackout from one plausible config entry, so the collapse here
 * resolves symlinks rather than trusting the string.
 *
 * A root that does not exist yields nothing and no error — Claude Code may
 * simply never have run under that account. A root that EXISTS and cannot be
 * enumerated is reported instead: it means the corpus is incomplete, and a
 * corpus that is quietly incomplete is the failure this feature refuses. A
 * directory nested inside a readable root is still skipped silently, because one
 * unreadable project must not cost the other 240 and its absence narrows the
 * corpus by a knowable amount rather than an unknown one.
 *
 * **An unchanged file is classified from the frontier, not from its bytes.** A
 * head read is up to 64 KiB per main-session file, so doing one every tick costs
 * roughly 11 MB of reads per five minutes per root and grows with both the
 * corpus and the root count — charged entirely against files that have not
 * changed. When `(size, mtime)` match what the frontier recorded, the working
 * directory comes from there.
 *
 * **The reuse is sound, and across roots the reason has to be stated carefully.**
 * A frontier row exists only for a file some earlier sweep decided to index, and
 * the eval-sandbox decision is a property of the head record, which cannot have
 * changed without the file changing. But the frontier is keyed by session id and
 * nothing else, so what a matching `(size, mtime)` proves is weaker than "this
 * exact file was classified": it is **"some file carrying this session id, this
 * byte count and this mtime was classified, on these exact bytes"** — possibly
 * one under another root.
 *
 * That is still enough, because of what the two cases are. Either the two paths
 * reach one file, and the classification is literally about these bytes; or they
 * are genuinely different files, in which case both are CONTESTED and
 * `jsonl-frontier.ts` refuses both before either is read, so nothing was decided
 * by the reuse at all. An eval sandbox never earns a frontier row to be reused
 * from, so it is head-read and excluded on every sweep, as it must be.
 *
 * @param projectsRoots - One `<claudeRoot>/projects` per Claude Code account.
 * @param known - What the frontier already holds, keyed by container id. Keyed
 *   by session id and therefore shared across roots, which is what lets an
 *   unchanged file skip its head read wherever it lives.
 * @param readCwd - How to read a transcript's head. Present so a test can prove
 *   the read is skipped; production never passes it.
 * @returns The files to index, the decisions taken against the rest, and the
 *   roots that could not be read.
 */
export async function discoverClaudeCodeTranscripts(
  projectsRoots: readonly string[],
  known: ReadonlyMap<string, KnownContainer> = new Map(),
  readCwd: HeadCwdReader = readHeadCwd
): Promise<FileDiscovery> {
  const files: FileContainer[] = [];
  const skipped: SkippedFile[] = [];
  const failures: DiscoveryFailure[] = [];

  for (const projectsRoot of await collapseRoots(projectsRoots)) {
    const walked = await walkJsonlFiles(projectsRoot);
    if (walked.failure !== null) failures.push({ root: projectsRoot, message: walked.failure });

    for (const candidate of walked.files) {
      const decision = await classifyTranscript(candidate, known, readCwd);
      if (decision === null) continue;
      if ('reason' in decision) skipped.push(decision);
      else files.push(decision);
    }
  }

  return { files, skipped, failures };
}

/**
 * Decide what one walked file is: a container to index, a decision to report, or
 * nothing at all.
 *
 * The third answer is the one that needs naming. A file that cannot be `stat`ed
 * is not a decision anybody made — it is a file that is no longer there, or one
 * this process may not reach — so it belongs in neither list.
 *
 * @param candidate - The file the walk found.
 * @param known - What the frontier holds, keyed by container id.
 * @param readCwd - How to read a transcript's head.
 * @returns The container, the skip decision, or `null` when the file went away.
 */
async function classifyTranscript(
  candidate: WalkedFile,
  known: ReadonlyMap<string, KnownContainer>,
  readCwd: HeadCwdReader
): Promise<FileContainer | SkippedFile | null> {
  const reason = classifyByPath(candidate.segments);
  if (reason !== null) return { path: candidate.filePath, reason };

  // The session id — the filename stem. Claude Code session ids are UUIDs, so
  // this is unique within a root, and unique ACROSS roots in practice, without
  // composing anything onto it. "In practice" is why the collision is asserted
  // downstream rather than assumed away here.
  const originKey = path.basename(candidate.filePath, '.jsonl');

  // Claude Code deletes transcripts past `cleanupPeriodDays` on its own
  // schedule, so the window between the walk's `readdir` and this `stat` is a
  // real ENOENT race and not a hypothetical one. Letting it throw would abandon
  // every remaining file in the root, which is how one unreadable project
  // directory stopped a whole sweep.
  let stat;
  try {
    stat = await fs.stat(candidate.filePath);
  } catch {
    return null;
  }
  const container: FileContainer = {
    originKey,
    filePath: candidate.filePath,
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

  const containerPath = await readCwd(candidate.filePath);

  // Tested against the `cwd`, NEVER against the directory slug. The slug is
  // `cwd.replace(/[^a-zA-Z0-9-]/g, '-')`, which collapses `/`, `.` and `_` all
  // to `-` and cannot be inverted — a slug test would be guessing at a path it
  // cannot recover.
  if (containerPath !== null && isEvalSandbox(containerPath)) {
    return { path: candidate.filePath, reason: 'eval-sandbox' };
  }

  return { ...container, containerPath };
}

/**
 * Why this path is not a main session, or `null` when it is one.
 *
 * The order is the decision order, and it matters: the subagent predicate is
 * asked before the depth check, so including subagent transcripts one day is a
 * change to one branch rather than a rewrite of the classifier.
 */
function classifyByPath(segments: string[]): SkippedFile['reason'] | null {
  const directories = segments.slice(0, -1);
  if (directories.includes(SUBAGENTS_DIR)) return 'subagent-transcript';
  if (directories.includes(PLUGIN_ARTIFACT_DIR)) return 'plugin-artifact';
  // A main session is `<slug>/<sessionId>.jsonl` and nothing deeper. Anything
  // else nested is reported rather than silently indexed, so a kind of file
  // nobody has seen yet shows up in the skipped set instead of in the index
  // under a made-up session id.
  if (directories.length !== 1) return 'not-a-main-session';
  return null;
}

/** Whether a working directory sits inside an eval-harness sandbox. */
function isEvalSandbox(cwd: string): boolean {
  // A path SEGMENT, never a substring: a repo legitimately called
  // `my-dorkos-evals-notes` is not a sandbox.
  return cwd.split(path.sep).some((segment) => segment.startsWith(EVAL_SANDBOX_PREFIX));
}

/**
 * The working directory a transcript's head records name, or `null` when its
 * opening chunk names none.
 *
 * Read from the file's own records because the directory slug cannot supply it —
 * the shipped transcript reader compensates the same way, and the projection
 * inherits the value from here rather than deriving one.
 *
 * Splits on `\n` alone, for the reason `jsonl-frontier.ts` documents at length.
 */
async function readHeadCwd(filePath: string): Promise<string | null> {
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
  // and parsing half a record would be reading a truncated `cwd`. A file that
  // fits inside the window keeps its final line, which is the whole file for a
  // transcript written without a trailing newline.
  if (truncated) lines.pop();

  for (const line of lines) {
    if (line.trim() === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const cwd = (record as { cwd?: unknown } | null)?.cwd;
    if (typeof cwd === 'string' && cwd !== '') return cwd;
  }
  return null;
}
