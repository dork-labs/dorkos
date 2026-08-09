/**
 * Derive "what is this session doing right now" from a single tool call.
 *
 * One pure function, fed by the projector on every `tool_call` and read
 * fleet-wide off `SessionStatus.activity`. It answers with facts only — the
 * tool's own name and, where the input carries one, the single argument a
 * person would recognize. It never phrases anything: the wording is the
 * client's, so a reading a server minted last month cannot put stale copy on
 * today's screen.
 *
 * The tool NAME is passed through verbatim, whatever the runtime calls it, and
 * the target lookup is case-insensitive so the same act reads the same on every
 * runtime: claude-code's `Bash`, codex's synthesized `Shell`, and opencode's
 * lowercase `bash` all yield a command excerpt. A name this module has never
 * seen yields the name alone — which is exactly what the client's fallback rung
 * needs, and strictly better than a guessed argument.
 *
 * @module services/session/activity/derive-activity
 */
import type { SessionActivity } from '@dorkos/shared/session-stream';

/**
 * Longest target this puts on the wire. A status row is one line on a narrow
 * sidebar; anything past this is truncated with an ellipsis rather than sent
 * and clipped by whoever draws it.
 */
export const ACTIVITY_TARGET_MAX_LENGTH = 40;

/** How a tool's target is read out of its JSON input. */
type TargetKind =
  /** A filesystem path — carried as its basename. */
  | 'path'
  /** Free text — carried as its first line, trimmed. */
  | 'text'
  /** A URL — carried as its host. */
  | 'host';

/** Which input field names the target, and how to read it, per tool. */
interface TargetRule {
  /** The JSON input key holding the target. */
  field: string;
  /** How to reduce that field's value to something readable. */
  kind: TargetKind;
}

/**
 * Target rules keyed by LOWERCASED tool name.
 *
 * Lowercased because the same tool arrives spelled three ways across the
 * runtimes (`Bash`/`bash`, `Read`/`read`, `WebFetch`/`webfetch`) and a
 * case-sensitive table would silently serve claude-code only. Codex's
 * synthesized `Shell` lands on the shell rule for the same reason; its
 * `ApplyPatch` carries a `changes` array instead of a path and is handled
 * separately below.
 */
const TARGET_RULES: Record<string, TargetRule> = {
  bash: { field: 'command', kind: 'text' },
  shell: { field: 'command', kind: 'text' },
  read: { field: 'file_path', kind: 'path' },
  write: { field: 'file_path', kind: 'path' },
  edit: { field: 'file_path', kind: 'path' },
  notebookedit: { field: 'notebook_path', kind: 'path' },
  glob: { field: 'pattern', kind: 'text' },
  grep: { field: 'pattern', kind: 'text' },
  websearch: { field: 'query', kind: 'text' },
  webfetch: { field: 'url', kind: 'host' },
  task: { field: 'description', kind: 'text' },
  skill: { field: 'skill', kind: 'text' },
};

/** Codex's synthesized patch tool, whose target lives in a `changes` array. */
const PATCH_TOOL_KEY = 'applypatch';

/**
 * Read what a session is doing from one tool call.
 *
 * @param toolName - The tool name as the runtime reported it.
 * @param input - The tool's JSON input, when the runtime carried one.
 * @returns The activity, or `undefined` when the call says nothing usable —
 *   which the wire represents as an absent field, never an empty object.
 */
export function deriveSessionActivity(
  toolName: string,
  input: string | undefined
): SessionActivity | undefined {
  const name = toolName.trim();
  if (name === '') return undefined;
  const target = readTarget(name, input);
  return target === undefined ? { toolName: name } : { toolName: name, target };
}

/** The readable target of a tool call, or `undefined` when there is none. */
function readTarget(toolName: string, input: string | undefined): string | undefined {
  if (input === undefined || input === '') return undefined;
  const key = toolName.toLowerCase();
  const rule = TARGET_RULES[key];
  if (rule === undefined && key !== PATCH_TOOL_KEY) return undefined;

  const parsed = parseInput(input);
  if (parsed === undefined) return undefined;

  if (rule === undefined) return firstChangedPath(parsed);

  const raw = parsed[rule.field];
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  return truncate(reduce(raw, rule.kind));
}

/** Parse a tool input as a JSON object, or `undefined` when it is not one. */
function parseInput(input: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The basename of the first file a codex patch touches. */
function firstChangedPath(parsed: Record<string, unknown>): string | undefined {
  const changes = parsed.changes;
  if (!Array.isArray(changes) || changes.length === 0) return undefined;
  const first: unknown = changes[0];
  if (first === null || typeof first !== 'object') return undefined;
  const path = (first as Record<string, unknown>).path;
  if (typeof path !== 'string' || path.trim() === '') return undefined;
  return truncate(basename(path));
}

/** Reduce a raw field value to the readable form its kind calls for. */
function reduce(raw: string, kind: TargetKind): string {
  if (kind === 'path') return basename(raw);
  if (kind === 'host') return host(raw);
  return firstLine(raw);
}

/** The last path segment, or the whole string when it has none. */
function basename(filePath: string): string {
  const segments = filePath.split('/').filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? filePath.trim();
}

/** A URL's host, falling back to the raw string when it will not parse. */
function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.trim();
  }
}

/** The first non-empty line of a multi-line value, trimmed. */
function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '');
  return line ?? text.trim();
}

/** Cut a target to {@link ACTIVITY_TARGET_MAX_LENGTH}, marking the cut. */
function truncate(text: string): string {
  return text.length > ACTIVITY_TARGET_MAX_LENGTH
    ? `${text.slice(0, ACTIVITY_TARGET_MAX_LENGTH)}…`
    : text;
}
