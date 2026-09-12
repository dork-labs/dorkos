/**
 * Which `control_ui` actions a surface with no way to ask a person must refuse,
 * and the sentence it refuses them with (DOR-639, moved and widened by spec
 * `canvas-agent-seat` §5).
 *
 * ## It tests the SURFACE, not a runtime's name
 *
 * This rule used to be called "refused on Codex", and it lived in the Codex
 * adapter beside the stub server that carried Codex's only copy of `control_ui`.
 * Both halves of that were accidents of where the verb happened to be
 * registered. What the rule really tests is whether the CALL arrived over the
 * loopback runtime surface — the authenticated listener Codex and OpenCode reach
 * DorkOS through — because that surface has no channel on which to put a
 * question to the person before doing something to their machine.
 *
 * So OpenCode gains a refusal it never had. That regresses nothing: it never had
 * the verb either.
 *
 * ## What "reaching past the screen" means
 *
 * `UI_COMMAND_REACH` (`@dorkos/shared/schemas`) classifies every `control_ui`
 * action, and the `reaches-the-machine` ones leave the browser. Today that is
 * `apply_layout`, which the app answers by POSTing `/api/shapes/:name/apply` —
 * and what that touches is a person's disk and configuration, not just pixels:
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
 * The reason to refuse is the writing, rewiring and deleting — which is plenty.
 *
 * ## Why refusal, rather than a card
 *
 * In a claude-code session the same call raises an approval card (DOR-625,
 * `claude-code/messaging/interactive-handlers.ts`). A turn reaching in over the
 * loopback listener has no card to raise: Codex pins `approvalPolicy: 'never'`
 * and declares `supportsToolApproval: false`, and no `ThreadEvent` can produce
 * `approval_required`. Nor does the route gate catch it — `POST /:name/apply` is
 * tier `destructive`, but the client dispatches the command from the person's
 * own browser session, which reads as a `trustedCaller` and skips the gate. So
 * this is the only place the question gets asked at all, and with no channel to
 * ask on, refusing is the only honest answer.
 *
 * Reads the table by action STRING rather than parsing `UiCommandSchema`,
 * because a refusal must not depend on the rest of the call being well-formed:
 * the whole point is to answer before anything is interpreted. Because
 * `UI_COMMAND_REACH` is a total `Record` over the action union, a new action
 * cannot be added without `tsc` demanding a reach verdict, and that verdict
 * lands here for free.
 *
 * @module services/session/browser-seat/ui-surface-consent
 */
import { UI_COMMAND_REACH } from '@dorkos/shared/schemas';
import type { UiCommand } from '@dorkos/shared/schemas';

/**
 * Whether this `control_ui` action reaches past the screen, and so must be
 * refused on a surface that cannot ask a person first.
 *
 * @param action - The `action` field of the `control_ui` call.
 * @returns `true` when the call must be refused instead of run.
 */
export function reachesPastTheScreen(action: string): boolean {
  return (
    Object.hasOwn(UI_COMMAND_REACH, action) &&
    UI_COMMAND_REACH[action as UiCommand['action']] !== 'client-only'
  );
}

/**
 * The sentence an agent reads when a call from outside the DorkOS app is
 * refused.
 *
 * Says what was refused and what to do instead, because a refusal an agent
 * cannot act on just gets retried.
 *
 * @param action - The `control_ui` action that was refused.
 * @returns The refusal, in one sentence a person could also read.
 */
export function uiActionRefusalMessage(action: string): string {
  return (
    `control_ui "${action}" is refused for an agent reaching in from outside the DorkOS app. ` +
    `It writes to this machine — changing files, configuration and scheduled work — and there ` +
    `is no way to ask the person first from here. Ask them to do it in the DorkOS app instead.`
  );
}
