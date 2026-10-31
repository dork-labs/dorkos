/**
 * Spot a refusal by the agent-folder secret denies, so a false one shows up
 * in the server log (DOR-3510).
 *
 * A bare name in {@link AGENT_FOLDER_SECRETS} can catch an ordinary file (a
 * bare `credentials` refused a whole `credentials/` docs folder, so it was
 * narrowed). The CLI's refusal never says which rule fired, and a `Read`
 * refusal doesn't even name the file, so without this a false refusal looks
 * like any other. Every refusal of a call whose path a secret name covers
 * logs one `[SecretReadDeny]` line with the name it matched; read those after
 * a release and narrow a name that bites. Another rule's refusal of such a
 * path (DorkOS's own `host.key`) logs too; the path in the line tells them
 * apart.
 *
 * @module services/runtimes/claude-code/secret-files/secret-deny-refusal
 */
import { logger } from '../../../../lib/logger.js';
import { AGENT_FOLDER_SECRETS } from './secret-read-deny.js';

/**
 * The CLI's refusals by a rule: `Permission to use Bash with command … has
 * been denied.` for a shell, and, for `Read`, `File is in a directory that is
 * denied by your permission settings.` (CLI 0.3.304, pinned in
 * `agent-folder-secret-deny.binary.test.ts`).
 */
const RULE_REFUSALS = [/has been denied\.?\s*$/, /denied by your permission settings/];

/** How many calls' paths are kept for their results: oldest go first. */
const MAX_REMEMBERED = 200;

/** A call's path, by `tool_use` id, until its result arrives. */
const targets = new Map<string, string>();

/** One secret name, without its `**\/` prefix, and the test it makes. */
interface SecretName {
  name: string;
  /** Whether a path's segments end in, or pass through, this name. */
  covers: (segments: readonly string[]) => boolean;
}

/** A name's glob (`*` only) as a whole-segment regex, case-insensitive like the CLI's hold of `.ENV`. */
function segmentPattern(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${body}$`, 'i');
}

const SECRET_NAMES: readonly SecretName[] = AGENT_FOLDER_SECRETS.map((rule) => {
  const name = rule.replace(/^\*\*\//, '');
  const parts = name.split('/').map(segmentPattern);
  return {
    name,
    covers: (segments) =>
      // Any run of segments, since a rule names a folder of that name too.
      segments.some((_, start) => parts.every((part, i) => part.test(segments[start + i] ?? ''))),
  };
});

/**
 * Keep a file tool's path for its result, which may not name it.
 *
 * @param block - One content block from an assistant message.
 */
export function rememberReadTarget(block: Record<string, unknown>): void {
  if (block.type !== 'tool_use' || typeof block.id !== 'string') return;
  const input = (block.input ?? {}) as { file_path?: unknown; path?: unknown };
  const target = typeof input.file_path === 'string' ? input.file_path : input.path;
  if (typeof target !== 'string') return;
  targets.set(block.id, target);
  if (targets.size > MAX_REMEMBERED) targets.delete(targets.keys().next().value!);
}

/**
 * The secret name a refusal covers, if any.
 *
 * @param resultText - A tool result's text.
 * @param target - The call's own path, when it had one.
 * @returns The first {@link AGENT_FOLDER_SECRETS} name (without `**\/`) that
 *   covers the call's path or a path in the text, or `undefined` when the text
 *   isn't a rule refusal or nothing it names is covered.
 */
export function secretDenyRefusalName(resultText: string, target?: string): string | undefined {
  if (!RULE_REFUSALS.some((refusal) => refusal.test(resultText))) return undefined;
  for (const token of [target ?? '', ...resultText.split(/\s+/)]) {
    const segments = token
      .replace(/^['"`(]+|['"`),.;:]+$/g, '')
      .split('/')
      .filter(Boolean);
    if (segments.length === 0) continue;
    const hit = SECRET_NAMES.find((secret) => secret.covers(segments));
    if (hit) return hit.name;
  }
  return undefined;
}

/**
 * Log one line when a failed tool result is a secret-name refusal.
 *
 * @param toolUseId - The call's `tool_use` id.
 * @param toolName - The refused tool.
 * @param resultText - The result's text.
 * @param isError - The block's `is_error` flag; only a failed result counts.
 */
export function noteSecretDenyRefusal(
  toolUseId: string,
  toolName: string,
  resultText: string,
  isError: boolean | undefined
): void {
  const target = targets.get(toolUseId);
  targets.delete(toolUseId);
  if (isError !== true) return;
  const name = secretDenyRefusalName(resultText, target);
  if (name === undefined) return;
  logger.info('[SecretReadDeny] refused a call under a secret name', {
    tool: toolName,
    name,
    ...(target !== undefined && { path: target }),
    refusal: resultText.slice(0, 300),
  });
}
