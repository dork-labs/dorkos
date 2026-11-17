/**
 * `operator.update_agent_config` (DOR-4266): write one setup file (a hook, a
 * setting, a skill) under an agent's `.claude/` folder through DorkOS, so a
 * change to another agent's setup no longer needs a person at a terminal.
 *
 * An agent's own shell and file tools can't do this, on purpose: the shell
 * guard refuses setup-file writes and Claude Code asks a person at the
 * computer for anything under `.claude/`, which a phone or web card can't
 * answer. This is the one sanctioned door, and it is `destructive`: a person
 * reads the whole file on the card, unless they set this one action to
 * Allowed.
 *
 * Three rules hold at every level, before any card:
 *
 * - the path is relative to the target's `.claude/` folder and stays inside
 *   it (no `..`, no absolute path, no backslash, no NUL);
 * - a turn that read words DorkOS can't vouch for is refused, Full included:
 *   a hook runs on every turn the target agent takes;
 * - the handler walks every folder on the way down with `lstat` and refuses a
 *   link, so a `.claude/` (or a subfolder, or the file) that points somewhere
 *   else can't carry the write out. The file is replaced by an atomic rename,
 *   never written through, so a hard link elsewhere is left alone.
 *
 * Wider gating of every file tool's writes into another agent's setup is
 * DOR-4266's second PR, not this module.
 *
 * @module services/core/operator/agent-config
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { readManifest } from '@dorkos/shared/manifest';
import { defineCapability, type CapabilityDeps } from '../capabilities/index.js';
import { unwrapMcpEnvelope } from '../capabilities/mcp-envelope.js';
import { registerPreGateRefusal } from '../capabilities/pre-gate-refusals.js';
import { marksOf } from '../turn-power/turn-levels.js';
import { marksHold } from '../turn-power/turn-marks.js';
import { validateBoundaryOrDorkHome } from '../../../lib/boundary.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import { agentSelectorSchema } from './agent-file-inputs.js';
import {
  agentUpdateFailure,
  jsonResult,
  resolveAgentPath,
  type OperatorToolResult,
} from './operator-tool-handlers.js';

const ID = 'operator.update_agent_config';

/** The folder every write lands under, inside the target agent's own folder. */
const CONFIG_DIR = '.claude';

/**
 * Longest file this writes. Under `APPROVAL_DETAIL_STORED_MAX_LENGTH` (16,000)
 * with room for redaction markers, so the card never shows a cut-off file.
 */
export const AGENT_CONFIG_MAX_CHARS = 12_000;

/** Longest relative path accepted. */
const PATH_MAX_CHARS = 512;

/** What a turn that read outsider words reads when it tries this. */
const OUTSIDER_REFUSAL =
  "This turn read words DorkOS can't vouch for, such as a Wi-Fi sign-in's, so it can't " +
  "change an agent's setup files. Ask the person to make the change.";

/** The call's arguments. */
export interface UpdateAgentConfigArgs {
  agent_id?: string;
  cwd?: string;
  /** Path relative to the agent's `.claude/` folder, e.g. `hooks/guard.py`. */
  path: string;
  /** The whole new file. */
  content: string;
  /** `true` makes the file runnable, `false` not; absent keeps what is there. */
  executable?: boolean;
}

/**
 * The folders and file name a relative path names, or a sentence saying why
 * it is refused. Pure, so the pre-gate check and the handler ask the same rule.
 *
 * @param relPath - The caller's path, relative to `.claude/`.
 */
export function agentConfigSegments(relPath: unknown): string[] | string {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    return 'Send path: where the file goes inside the agent’s .claude folder, e.g. settings.json.';
  }
  if (relPath.length > PATH_MAX_CHARS) return `path is longer than ${PATH_MAX_CHARS} characters.`;
  if (relPath.includes('\0') || relPath.includes('\\')) {
    return 'path may not hold a backslash or a NUL character. Use / between folders.';
  }
  if (path.posix.isAbsolute(relPath) || relPath.startsWith('~')) {
    return 'path is relative to the agent’s .claude folder, e.g. hooks/guard.py, never absolute.';
  }
  const segments = relPath.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return 'path names the .claude folder itself, not a file in it.';
  if (segments.includes('..')) return 'path may not leave the agent’s .claude folder (no "..").';
  if (segments[0] === CONFIG_DIR) {
    return 'path is already relative to .claude. Leave the leading ".claude/" out.';
  }
  return segments;
}

// Before the gate, so no level, card or saved Allowed reaches a write that
// could leave the folder or that a stranger's words asked for (DOR-4060).
registerPreGateRefusal(ID, (input, caller) => {
  if (marksHold(marksOf(caller.sessionId, caller.agentPath))) return OUTSIDER_REFUSAL;
  const segments = agentConfigSegments((input as { path?: unknown } | null)?.path);
  return typeof segments === 'string' ? segments : null;
});

/** A typed refusal the handler returns. */
function refuse(code: string, error: string): OperatorToolResult {
  return jsonResult({ error, code }, true);
}

/** The `lstat` of a path, or `null` when nothing is there. */
async function lstatOrNull(p: string) {
  try {
    return await lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Why a path can't hold the write, or `null` when it is a real folder (made if missing). */
async function ensureRealDir(dir: string): Promise<string | null> {
  const found = await lstatOrNull(dir);
  if (found === null) {
    await mkdir(dir);
    return null;
  }
  if (found.isSymbolicLink()) return `${dir} is a link, so a write there could leave the agent.`;
  if (!found.isDirectory()) return `${dir} is a file, not a folder.`;
  return null;
}

/**
 * The handler: resolve the agent, walk to the file without following a link,
 * and replace it atomically.
 *
 * @param deps - Tool deps (`meshCore` for `agent_id` resolution).
 */
export function createUpdateAgentConfigHandler(deps: McpToolDeps) {
  return async (args: UpdateAgentConfigArgs): Promise<OperatorToolResult> => {
    try {
      const segments = agentConfigSegments(args.path);
      if (typeof segments === 'string') return refuse('VALIDATION', segments);
      if (args.path.endsWith('.json')) {
        try {
          JSON.parse(args.content);
        } catch {
          return refuse('VALIDATION', `${args.path} is not valid JSON, so nothing was written.`);
        }
      }
      const agentPath = await validateBoundaryOrDorkHome(resolveAgentPath(deps, args));
      const manifest = await readManifest(agentPath);
      if (!manifest) return refuse('NOT_FOUND', `No agent at ${agentPath}.`);

      let dir = path.join(agentPath, CONFIG_DIR);
      for (const segment of [null, ...segments.slice(0, -1)]) {
        if (segment !== null) dir = path.join(dir, segment);
        const problem = await ensureRealDir(dir);
        if (problem) return refuse('OUTSIDE_AGENT_CONFIG', problem);
      }
      const target = path.join(dir, segments[segments.length - 1]!);
      const existing = await lstatOrNull(target);
      if (existing && !existing.isFile()) {
        return refuse(
          'OUTSIDE_AGENT_CONFIG',
          `${target} is a link or a folder, so it was left alone.`
        );
      }

      const mode =
        args.executable === true
          ? 0o755
          : args.executable === false
            ? 0o644
            : existing
              ? existing.mode & 0o777
              : 0o644;
      const temp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}`);
      try {
        await writeFile(temp, args.content, { encoding: 'utf8', flag: 'wx', mode });
        await rename(temp, target);
      } catch (err) {
        await rm(temp, { force: true });
        throw err;
      }
      return jsonResult({
        agent: manifest.name,
        path: [CONFIG_DIR, ...segments].join('/'),
        bytes: Buffer.byteLength(args.content, 'utf8'),
        created: existing === null,
        executable: (mode & 0o100) !== 0,
      });
    } catch (err) {
      return agentUpdateFailure(err, "Failed to write the agent's setup file");
    }
  };
}

/**
 * The capability. Built by a factory so the operator domain hands in its own
 * dependency check, rather than this module importing the domain back.
 *
 * @param requireDeps - The operator domain's dependency check.
 */
export function defineUpdateAgentConfig(requireDeps: (deps: CapabilityDeps) => McpToolDeps) {
  return defineCapability({
    id: ID,
    title: "Change an agent's setup file",
    description:
      "Write one setup file under an agent's .claude folder: a hook, settings.json or a skill. " +
      'Use it for another agent, whose setup your own file tools and shell can’t change. path ' +
      'is relative to that folder (hooks/guard.py, settings.json, skills/x/SKILL.md); content is ' +
      'the whole new file, replacing what is there, so read the current file first. A .json ' +
      'file must be valid JSON. executable: true makes a hook runnable. Target the agent by ' +
      'agent_id or cwd. A person reads the whole file and approves it unless they set this ' +
      'action to Allowed, so say plainly what the change does and why before you ask.',
    tier: 'destructive',
    // Other agents: it changes an agent.
    area: 'agents',
    // A hook is code the target agent's runtime runs on every turn, so an
    // area-level Allowed (Trusted's default) still asks; only an Allowed set on
    // this one action runs it without a card.
    consent: 'third-party-code',
    input: z.object({
      ...agentSelectorSchema,
      // No `.min(1)`: an empty path reaches the pre-gate check and gets a
      // sentence, rather than a raw Zod error from the registry's parse.
      path: z
        .string()
        .max(PATH_MAX_CHARS)
        .describe("Where the file goes, relative to the agent's .claude folder"),
      content: z.string().max(AGENT_CONFIG_MAX_CHARS).describe('The whole new file'),
      executable: z
        .boolean()
        .optional()
        .describe('true makes the file runnable (a hook), false not; left out keeps what is there'),
    }),
    output: z.unknown(),
    approvalDisplayFields: ['path', 'agent_id', 'cwd', 'executable'],
    // The file itself is the decision, so it rides the card's detail whole,
    // never the sentence's 80-character preview.
    approvalDetailField: 'content',
    surfaces: {
      mcp: {
        toolName: 'update_agent_config',
        servers: ['in-session', 'external'],
        annotations: { idempotentHint: true },
      },
    },
    invoke: async (deps, input) =>
      unwrapMcpEnvelope(
        await createUpdateAgentConfigHandler(requireDeps(deps))(input as UpdateAgentConfigArgs)
      ),
  });
}
