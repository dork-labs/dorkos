/**
 * Unreadable-hook reporting — say out loud what the `hooks/hooks.json` salvage
 * had to throw away.
 *
 * The scanner keeps whatever a malformed plugin `hooks/hooks.json` still states
 * clearly and discards the rest, so one sloppy package can no longer take down
 * `dorkos harness sync` for every other package (DOR-646). What it discards is a
 * shell command the package meant to run and now will not, and that used to
 * happen in silence: the marketplace permission preview discloses the same file,
 * but it runs BEFORE the install, so a file that rots afterwards — a hand-edit, a
 * partial write — dropped hooks with no disclosure anywhere, and the CLI path has
 * no approval gate to re-ask through. This module is that disclosure (DOR-1724).
 *
 * It lives beside the installed-plugin projector rather than inside it because it
 * reports a SOURCE-READ loss, not a projection: the evidence is gathered before
 * any harness is considered, and it is emitted once per plan.
 *
 * @module plan/unreadable-hooks
 */
import type { HarnessId } from '../manifest/schema.js';
import type { InstalledPlugin, UnreadableHookDeclaration } from '../sources/installed.js';
import type { ProjectionWarning } from './types.js';

/**
 * The harness an unreadable-hook warning is attributed to.
 *
 * The loss is harness-agnostic — a hook declaration the reader could not use
 * reaches no harness at all, neither the Claude Code settings merge nor the
 * generated Codex/Cursor/Copilot files — but every {@link ProjectionWarning} must
 * name one. claude-code is the honest answer available: the file is a
 * Claude-plugin `hooks/hooks.json`, and claude-code is the only harness that takes
 * an installed plugin's hooks in their native form.
 *
 * Know how that reads: `formatWarnings` groups by harness, so a project that
 * enables codex alone still gets told about the loss — under a `claude-code:`
 * heading naming a harness it does not run. The reason line carries the file and
 * the event, which is what the person acts on. The one place the attribution
 * costs something is `dorkos harness sync --harness <id>`, which narrows the plan
 * by harness and so hides these warnings for every `<id>` but `claude-code`.
 */
const UNREADABLE_HOOK_ATTRIBUTION: HarnessId = 'claude-code';

/**
 * Turn one unreadable hook declaration into a human-readable reason.
 *
 * Each reason names the FILE and, when there is one, the EVENT — the two things
 * someone needs to go and fix it — and says plainly whether anything from that
 * declaration still runs.
 */
function unreadableHookReason(declaration: UnreadableHookDeclaration): string {
  if (declaration.event === undefined) {
    return `${declaration.path} could not be read (invalid JSON, or a top level that is not an object), so every hook this package declares was dropped and none are projected`;
  }
  if (declaration.total) {
    return `${declaration.path} declares "${declaration.event}" in a shape this reader cannot use, so the whole event was dropped and no "${declaration.event}" hook is projected`;
  }
  return `${declaration.path} declares one or more unusable matcher groups under "${declaration.event}", so those were dropped and only the readable ones are projected`;
}

/**
 * Warn about every hook declaration the scanner salvaged around.
 *
 * A warning rather than a drop, deliberately: `plan.drops` reports a whole
 * artifact that has no home in a target harness, while this is a source file the
 * engine could not fully read. One warning per bad declaration, not one per
 * enabled harness — the loss happened at read time, ahead of every harness.
 *
 * @param plugins - the plugins whose hooks are actually allowed to contribute (a
 *   package excluded by the hook gate projects no hooks either way, so its
 *   salvage losses would be noise).
 * @returns one warning per unreadable declaration, empty when every scanned
 *   `hooks/hooks.json` was fully readable.
 */
export function planUnreadableHookWarnings(
  plugins: readonly InstalledPlugin[]
): ProjectionWarning[] {
  const warnings: ProjectionWarning[] = [];
  for (const plugin of plugins) {
    for (const declaration of plugin.unreadableHooks ?? []) {
      warnings.push({
        artifact: 'hook',
        harness: UNREADABLE_HOOK_ATTRIBUTION,
        name: `${plugin.name}:${declaration.event ?? 'hooks'}`,
        reason: unreadableHookReason(declaration),
      });
    }
  }
  return warnings;
}
