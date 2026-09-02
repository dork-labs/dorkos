/**
 * Codex's consent policy for `control_ui`: which actions this runtime refuses,
 * and the sentence it refuses them with (DOR-639).
 *
 * Its own module because two collaborators enforce one rule and neither owns it.
 * The scoped `dorkos_ui` MCP server ({@link ./codex-ui-mcp-server}) returns the
 * refusal to the agent; the event-mapper ({@link ./event-mapper}) is what
 * actually withholds the effect. Parking the policy in either would make the
 * other import a peer for a decision that belongs to the runtime.
 *
 * @module services/runtimes/codex/ui-command-consent
 */
import { UI_COMMAND_REACH } from '@dorkos/shared/schemas';
import type { UiCommand } from '@dorkos/shared/schemas';

/** Error code on the refusal the event-mapper emits (DOR-639). */
export const UI_COMMAND_REFUSED_CODE = 'ui_command_refused';

/**
 * Whether Codex must refuse one `control_ui` action outright (DOR-639).
 *
 * `UI_COMMAND_REACH` (`@dorkos/shared/schemas`) classifies every `control_ui`
 * action, and the `reaches-the-machine` ones leave the browser. Today that is
 * `apply_layout`, which the cockpit answers by POSTing `/api/shapes/:name/apply`
 * — and what that touches is a person's disk and configuration, not just pixels:
 * it writes a `SKILL.md` into their skills root for each schedule the Shape
 * declares, records a receipt under the DorkOS home naming what it wrote, always
 * rewrites `ui.shapes.active` in `~/.dork/config.json`, creates, rebinds and
 * DELETES the scheduled tasks its own receipt claims, and enables and disables
 * extensions (which the client then remounts live).
 *
 * What it does NOT do, despite a claim that outlived its fix: it cannot stand up
 * an unattended job running with prompts off. `clampSchedulePermissionMode`
 * downgrades a manifest's `bypassPermissions` to `acceptEdits` (DOR-607), a
 * schedule is created enabled only if the manifest asked AND its agent already
 * exists, and `resolveFileArmStatus` parks newly-discovered schedules at
 * `pending_approval` so none can fire before a person approves it (DOR-1486).
 * The reason to refuse is the writing, rewiring and deleting — which is plenty —
 * not a cron-with-no-prompts story that is no longer true.
 *
 * ## Why refusal, rather than a card
 *
 * On claude-code the same call raises an approval card (DOR-625,
 * `claude-code/messaging/interactive-handlers.ts`). Codex has no card to raise:
 * `turn-input.ts` pins `approvalPolicy: 'never'`, `runtime-constants.ts` declares
 * `supportsToolApproval: false`, and no `ThreadEvent` can produce
 * `approval_required`. Nor does the route gate catch it — `POST /:name/apply` is
 * tier `destructive`, but the client dispatches the command from the person's own
 * browser session, which reads as a `trustedCaller` and skips the gate. So this is
 * the only place the question gets asked at all, and with no channel to ask on,
 * refusing is the only honest answer.
 *
 * Reads the table by action STRING rather than parsing `UiCommandSchema`, because
 * the MCP handler sees arguments already narrowed to `CONTROL_UI_INPUT`'s keys —
 * an `apply_layout` call arrives there stripped of its required `shape` and would
 * fail a full parse. The action name is the one field both call sites can rely on.
 * Because `UI_COMMAND_REACH` is a total `Record` over the action union, a new
 * action cannot be added without `tsc` demanding a reach verdict, and that verdict
 * lands here for free.
 *
 * @param action - The `action` field of the `control_ui` call
 * @returns `true` when Codex must refuse the call instead of running it
 */
export function isUiActionRefusedOnCodex(action: string): boolean {
  return (
    Object.hasOwn(UI_COMMAND_REACH, action) &&
    UI_COMMAND_REACH[action as UiCommand['action']] !== 'client-only'
  );
}

/**
 * The sentence an agent reads when Codex refuses its `control_ui` call.
 *
 * Says what was refused and what to do instead, because a refusal an agent
 * cannot act on just gets retried. Shared by the MCP stub (which returns it as
 * the tool result the model actually reads) and the event-mapper (which puts it
 * in the transcript's error event), so the two can never say different things.
 *
 * @param action - The `control_ui` action that was refused
 */
export function uiActionRefusalMessage(action: string): string {
  return (
    `control_ui "${action}" is refused on Codex. It writes to this machine — ` +
    `changing files, configuration and scheduled work — and a Codex session has no ` +
    `way to ask the person first. Ask them to do it in the DorkOS app instead.`
  );
}
