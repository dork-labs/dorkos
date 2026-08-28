import path from 'node:path';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { PendingInteractionDTO } from '@dorkos/shared/schemas';
import type {
  NotificationDTO,
  NotificationTier,
  StandingPendingEvent,
} from '@dorkos/shared/notification-schemas';

/**
 * What a desktop notification says, and where its click goes — kept apart
 * from the SSE plumbing in `notifications/index.ts` so the wording and
 * routing rules can be read (and tested) on their own (spec
 * `notification-system`, Desktop section).
 *
 * @module main/notifications/copy
 */

/** Longest a reply field's placeholder is allowed to be before it's truncated. */
const REPLY_PLACEHOLDER_MAX_LENGTH = 120;

/**
 * What to call a session in a sentence — the working directory's own name,
 * the identity fallback every session surface uses when nothing has named the
 * agent for it yet.
 *
 * Mirrors `sessionLabelFor` in `apps/server/src/services/notifications/
 * emitters/session-lifecycle.ts` exactly. Not imported from there: that file
 * lives on the server side of the process boundary, and pulling server code
 * into the Electron main bundle is not a trade this module makes for one
 * three-line function.
 *
 * @param cwd - The session's working directory.
 */
export function sessionLabelFor(cwd: string | undefined): string {
  if (!cwd) return 'A session';
  return path.basename(cwd) || 'A session';
}

/**
 * One line saying what an Ask wants — never the tool's raw input, which is the
 * command line an agent proposed to run and does not belong on a lock screen.
 *
 * @param interaction - The pending interaction.
 */
function summarizeAsk(interaction: PendingInteractionDTO): string {
  if (interaction.type === 'approval') {
    return interaction.displayName ?? interaction.title ?? `Wants to run ${interaction.toolName}`;
  }
  if (interaction.type === 'question') {
    const [first] = interaction.questions;
    if (interaction.questions.length === 1 && first) return first.question;
    return `Asked you ${interaction.questions.length} questions`;
  }
  return interaction.message;
}

/** Title and body of a native banner. */
export interface NotificationCopy {
  title: string;
  body?: string;
}

/**
 * The banner for a live, pending Ask.
 *
 * @param ask - The interaction, as `interaction_pending` broadcast it.
 */
export function askCopy(ask: InteractionPendingEvent): NotificationCopy {
  return {
    title: `${sessionLabelFor(ask.cwd)} is waiting on your answer`,
    body: summarizeAsk(ask.interaction),
  };
}

/**
 * Whether a single-question Ask can offer a reply field, and the placeholder
 * to show in it.
 *
 * A native notification has exactly one free-text field, so only a truly
 * open-ended question is eligible. Three shapes are excluded, each for the
 * same reason — none of them can be answered honestly from one line of typed
 * text — and all three fall back to click-to-open, where the real form is
 * drawn:
 *
 * - More than one question: a reply field is one answer, not a form.
 * - `multiSelect`: the answer is a set, not a string.
 * - A **single**-select question that still carries fixed `options`: typing
 *   over a `<select>` risks an answer matching none of the choices the agent
 *   offered, which is not the same failure as skipping the question — it
 *   reads back as a real answer that happens to be wrong. Only a question
 *   with `options: []` — genuinely freeform — gets a reply field.
 *
 * @param interaction - The pending interaction.
 */
export function replyEligibility(
  interaction: PendingInteractionDTO
): { placeholder: string } | null {
  if (interaction.type !== 'question' || interaction.questions.length !== 1) return null;
  const [question] = interaction.questions;
  if (!question || question.multiSelect || question.options.length > 0) return null;
  const text = question.question;
  const placeholder =
    text.length > REPLY_PLACEHOLDER_MAX_LENGTH
      ? `${text.slice(0, REPLY_PLACEHOLDER_MAX_LENGTH - 1)}…`
      : text;
  return { placeholder };
}

/** The client route a click on the Ask's banner opens. */
export function askDeepLink(ask: InteractionPendingEvent): string {
  return `/session?session=${encodeURIComponent(ask.sessionId)}`;
}

/**
 * Whether `tier` earns a native banner right now.
 *
 * Blocking always does — it is the one tier allowed to interrupt. Notable
 * only surfaces while nobody is looking at a DorkOS window; the moment one is
 * focused, the in-app surfaces (the bell, the toast diet) are the loud-enough
 * channel. Quiet never does — that is the whole point of the tier.
 *
 * @param tier - The notification's tier.
 * @param isWindowUnfocused - True when no cockpit window currently has OS focus.
 */
export function earnsNativeBanner(tier: NotificationTier, isWindowUnfocused: boolean): boolean {
  if (tier === 'quiet') return false;
  if (tier === 'blocking') return true;
  return isWindowUnfocused;
}

/**
 * The banner for a standing condition that just started waiting on a person —
 * a schedule an agent proposed, or an approval it needs for something
 * irreversible (DOR-1570).
 *
 * Both sentences are written on the SERVER, by the notification registry, and
 * carried on the event. That is deliberate: the registry is where the product's
 * whole interruption budget is meant to be readable in one screen, and a second
 * copy of the wording here would let a banner and an inbox row describe one
 * condition two ways.
 *
 * @param event - The `standing_pending` payload.
 */
export function standingCopy(event: StandingPendingEvent): NotificationCopy {
  return { title: event.title, ...(event.body ? { body: event.body } : {}) };
}

/**
 * The client route a click on a `notification` DTO's banner opens.
 *
 * Best-effort by subject type: `session` and `room` have a real addressable
 * route today; `task`/`run` land on the Tasks page (there is no per-task deep
 * link yet); `agent` opens that roster member's profile from any route, since
 * `?profile=` is a dialog param merged into every route's search schema;
 * `system` just brings the app forward.
 *
 * @param dto - The notification.
 */
export function notificationDeepLink(dto: NotificationDTO): string {
  switch (dto.subject.type) {
    case 'session':
      return `/session?session=${encodeURIComponent(dto.sessionId ?? dto.subject.id)}`;
    case 'room':
      return `/channels?id=${encodeURIComponent(dto.roomId ?? dto.subject.id)}`;
    case 'agent':
      return `/?profile=${encodeURIComponent(dto.agentId ?? dto.subject.id)}`;
    case 'task':
    case 'run':
      return '/tasks';
    case 'system':
      return '/';
  }
}
