/**
 * Finding the Claude Code transcripts worth indexing — and deciding, on the
 * record, against the ones that are not (message-search spec §2.1).
 *
 * The projects root is not flat. On the operator's machine it holds 241 main
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
 * @module server/services/search/claude-code-discovery
 */
import fs from 'fs/promises';
import path from 'path';
import type { FileContainer, FileDiscovery, KnownContainer, SkippedFile } from './types.js';

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
 * Every transcript under one projects root that should be indexed, and every one
 * that should not.
 *
 * A root that does not exist yields nothing and no error — Claude Code may
 * simply never have run here. A directory inside it that cannot be read is
 * skipped the same way, because one unreadable project must not cost the other
 * 240.
 *
 * **An unchanged file is classified from the frontier, not from its bytes.** A
 * head read is up to 64 KiB per main-session file, so doing one every tick costs
 * roughly 11 MB of reads per five minutes on this corpus and grows with it —
 * charged entirely against files that have not changed. When `(size, mtime)`
 * match what the frontier recorded, the working directory comes from there.
 *
 * **The reuse is sound because of what a frontier row means.** A row exists only
 * for a file some earlier sweep decided to index, and the eval-sandbox decision
 * is a property of the head record, which cannot have changed without the file
 * changing. So a matching fingerprint is not "probably still the same path", it
 * is "this exact classification was already made, on these exact bytes". An eval
 * sandbox never earns a frontier row to be reused from, so it is head-read and
 * excluded on every sweep, as it must be.
 *
 * @param projectsRoot - `<claudeRoot>/projects`.
 * @param known - What the frontier already holds, keyed by container id.
 * @param readCwd - How to read a transcript's head. Present so a test can prove
 *   the read is skipped; production never passes it.
 * @returns The files to index and the decisions taken against the rest.
 */
export async function discoverClaudeCodeTranscripts(
  projectsRoot: string,
  known: ReadonlyMap<string, KnownContainer> = new Map(),
  readCwd: HeadCwdReader = readHeadCwd
): Promise<FileDiscovery> {
  const files: FileContainer[] = [];
  const skipped: SkippedFile[] = [];

  for (const candidate of await walkJsonlFiles(projectsRoot)) {
    const reason = classifyByPath(candidate.segments);
    if (reason !== null) {
      skipped.push({ path: candidate.filePath, reason });
      continue;
    }

    // The session id — the filename stem. Claude Code session ids are UUIDs, so
    // this is unique within a root without composing anything onto it.
    const originKey = path.basename(candidate.filePath, '.jsonl');

    // A file that cannot be stat'd is not a decision — it is a file that is no
    // longer there, or one this process may not reach. Claude Code deletes
    // transcripts past `cleanupPeriodDays` on its own schedule, so the window
    // between this walk's `readdir` and this `stat` is a real ENOENT race and
    // not a hypothetical one. It contributes nothing and costs nothing else:
    // letting it throw would abandon every remaining file in the root, which is
    // how one unreadable project directory stopped a whole sweep.
    let stat;
    try {
      stat = await fs.stat(candidate.filePath);
    } catch {
      continue;
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
      files.push({ ...container, containerPath: settled.containerPath });
      continue;
    }

    const containerPath = await readCwd(candidate.filePath);

    // Tested against the `cwd`, NEVER against the directory slug. The slug is
    // `cwd.replace(/[^a-zA-Z0-9-]/g, '-')`, which collapses `/`, `.` and `_`
    // all to `-` and cannot be inverted — a slug test would be guessing at a
    // path it cannot recover.
    if (containerPath !== null && isEvalSandbox(containerPath)) {
      skipped.push({ path: candidate.filePath, reason: 'eval-sandbox' });
      continue;
    }

    files.push({ ...container, containerPath });
  }

  return { files, skipped };
}

/** One `.jsonl` file the walk found, with its path relative to the root already split. */
interface WalkedFile {
  /** Absolute path. */
  filePath: string;

  /** Path segments below the projects root — `['<slug>', '<sessionId>.jsonl']` for a main session. */
  segments: string[];
}

/**
 * Every `.jsonl` file anywhere under a root, in walk order.
 *
 * Recursion is the point (see this module's header) and it is also cheap: the
 * result is one `readdir` per directory, with `withFileTypes` so no extra `stat`
 * is paid to tell a file from a directory. Symbolic links are not followed —
 * a link back up the tree would otherwise walk forever.
 */
async function walkJsonlFiles(root: string): Promise<WalkedFile[]> {
  const found: WalkedFile[] = [];

  async function visit(dir: string, segments: string[]): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // A root Claude Code never wrote, or a directory this process may not
      // read. Either way it contributes nothing, which is the same shape as a
      // project with no sessions.
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full, [...segments, entry.name]);
      else if (entry.isFile() && entry.name.endsWith('.jsonl'))
        found.push({ filePath: full, segments: [...segments, entry.name] });
    }
  }

  await visit(root, []);
  return found;
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
