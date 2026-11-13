/**
 * Undo one standing yes for a global MCP server (DOR-4118).
 *
 * Removes one exact `mcp__{server}`, `mcp__{server}__*` or `mcp__{server}__{tool}` string from an
 * agent's `.claude/settings.local.json`, the file `keepAlwaysAllowToAgent`
 * writes. Agents are kept from writing that file, so this writer is held to
 * Security's conditions (Nov 12):
 *
 * - **Remove only.** The rule must fully match {@link UNDOABLE_RULE}, and the
 *   only change is that string leaving `permissions.allow`. Nothing it is given
 *   can add a rule; every other key is written back unchanged.
 * - **The folder comes from the registry.** The caller resolves the agent's
 *   home by id; the request never names a path. The settings file, and the
 *   `.claude` folder holding it, must be real (no symlink) and inside that home.
 * - **Temp file, then rename**, so a reader finds the old file or the new one,
 *   not half of either.
 * - **Person-only.** Only the `/api/mcp-servers` routes call this: it is no
 *   MCP tool and no capability, and the route audits every removal.
 *
 * The folder's allow-list hash changes with it, so the next launch in that
 * folder asks the person again. That is intended.
 *
 * @module services/mesh/global-mcp/global-mcp-allow-undo
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * The only rules Undo may take: a bare server, `mcp__{server}__*` (the same
 * reach, DOR-4240), or one tool on it.
 */
export const UNDOABLE_RULE = /^mcp__[A-Za-z0-9_-]+(__([A-Za-z0-9_-]+|\*))?$/;

/** Why an Undo was refused before anything was written. */
export class StandingAllowUndoError extends Error {
  /**
   * Build the refusal.
   *
   * @param code - What went wrong, for the route's status.
   * @param message - The sentence the person reads.
   */
  constructor(
    readonly code: 'bad-rule' | 'not-a-real-file' | 'unreadable',
    message: string
  ) {
    super(message);
    this.name = 'StandingAllowUndoError';
  }
}

/** A path's real location, which must be `home` itself or inside it. */
async function realInside(home: string, target: string): Promise<boolean> {
  const [realHome, real] = await Promise.all([fs.realpath(home), fs.realpath(target)]);
  return real === realHome || real.startsWith(realHome + path.sep);
}

/** Refuse a path that is a symlink, is not what `kind` expects, or resolves outside `home`. */
async function refuseUnlessReal(home: string, target: string, kind: 'file' | 'dir'): Promise<void> {
  const stat = await fs.lstat(target);
  const right = kind === 'file' ? stat.isFile() : stat.isDirectory();
  if (stat.isSymbolicLink() || !right || !(await realInside(home, target))) {
    throw new StandingAllowUndoError(
      'not-a-real-file',
      "This agent's settings file isn't a plain file in its folder, so it was left alone."
    );
  }
}

/**
 * Remove one standing yes from an agent's local settings.
 *
 * @param home - The agent's registered home, from the registry.
 * @param rule - The exact rule to remove.
 * @returns `removed`, or `not-found` when the file does not hold that rule.
 * @throws {StandingAllowUndoError} When the rule is not undoable or the file is not a real one.
 */
export async function removeStandingAllow(
  home: string,
  rule: string
): Promise<'removed' | 'not-found'> {
  if (!UNDOABLE_RULE.test(rule)) {
    throw new StandingAllowUndoError('bad-rule', 'Only an MCP server rule can be undone here.');
  }
  const folder = path.join(home, '.claude');
  const file = path.join(folder, 'settings.local.json');
  try {
    await fs.lstat(file);
  } catch {
    return 'not-found';
  }
  await refuseUnlessReal(home, folder, 'dir');
  await refuseUnlessReal(home, file, 'file');

  let text: string;
  let settings: Record<string, unknown>;
  try {
    text = await fs.readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    settings = parsed as Record<string, unknown>;
  } catch {
    throw new StandingAllowUndoError('unreadable', "This agent's settings file couldn't be read.");
  }
  const permissions = settings.permissions as Record<string, unknown> | undefined;
  const allow = permissions?.allow;
  if (!Array.isArray(allow) || !allow.includes(rule)) return 'not-found';

  const next = {
    ...settings,
    permissions: { ...permissions, allow: allow.filter((entry) => entry !== rule) },
  };
  // Keep the file's own indent, so a person's diff shows only the one line.
  const indent = /\n( +|\t)"/.exec(text)?.[1] ?? 2;
  const body = JSON.stringify(next, null, indent) + (text.endsWith('\n') ? '\n' : '');
  const { mode } = await fs.stat(file);
  const temp = path.join(folder, `.settings.local.json.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temp, body, { mode: mode & 0o777, flag: 'wx' });
  try {
    // Checked again just before the swap: the folder may have changed meanwhile.
    await refuseUnlessReal(home, folder, 'dir');
    await fs.rename(temp, file);
  } catch (err) {
    await fs.rm(temp, { force: true });
    throw err;
  }
  return 'removed';
}
