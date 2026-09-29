/**
 * The checks every `ctx.inbox` write runs before anything is stored (spec
 * `flow-multiproject` §7.1, §11.2).
 *
 * Each one throws {@link InboxLimitError} or {@link InboxLinkError} with the
 * limit it broke and a plain sentence, and writes nothing: a decision that is
 * too long, has no reason, or links outside the app never reaches a person.
 * What an action handler answers is checked here too, since a bad `navigate`
 * is treated as a handler error rather than followed.
 *
 * @module services/extensions/extension-inbox-validate
 */
import {
  InboxLimitError,
  InboxLinkError,
  type DecisionActionResult,
  type DecisionActions,
  type DecisionActor,
  type DecisionInput,
  type DecisionOffer,
  type DecisionWatch,
} from '@dorkos/extension-api/server';
import type { DecisionActionRequest } from '@dorkos/shared/extension-decision-schemas';
import {
  DECIDE_BY_MAX_MS,
  DECIDE_BY_MIN_MS,
  DECISION_KEY_PATTERN,
  DECISION_LIMITS,
  PROJECT_SETTINGS_MAX_BYTES,
  DecisionActionsSchema,
} from '@dorkos/shared/extension-decision-schemas';
import { isAllowedExtensionLink } from './extension-links.js';

/** A decision's fields once checked and trimmed, ready to store. */
export interface CheckedDecision {
  key: string;
  title: string;
  why: string;
  detail: string | null;
  project: string | null;
  projectLabel: string | null;
  since: string | null;
  /** As the extension asked, a question's `decideBy` unclamped. */
  actions: DecisionActions;
  link: string | null;
  /** A question's deadline, clamped, or null. */
  decideBy: string | null;
  /** A question's agent's pick, or null. */
  defaultChoice: string | null;
}

/** An action handler's answer once checked. */
export type CheckedActionResult =
  | {
      kind: 'resolve';
      outcome: 'approved' | 'rejected' | 'answered';
      navigate: string | null;
      offer: DecisionOffer | null;
      message: string | null;
      watch: DecisionWatch | null;
    }
  | {
      kind: 'keepOpen';
      navigate: string | null;
      message: string | null;
      watch: DecisionWatch | null;
    }
  | { kind: 'settled' };

/** Why a handler's answer was refused. */
export class HandlerAnswerError extends Error {
  /**
   * Refuse a handler's answer.
   *
   * @param message - What was wrong with the answer.
   */
  constructor(message: string) {
    super(message);
    this.name = 'HandlerAnswerError';
  }
}

/** A trimmed string, or `undefined` when absent. Throws when present but not a string. */
function text(value: unknown, limit: InboxLimitError['limit'], name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new InboxLimitError(limit, `${name} must be plain text.`);
  return value.trim();
}

/** A required string of 1 to `max` characters after trimming. */
function required(
  value: unknown,
  max: number,
  limit: InboxLimitError['limit'],
  name: string
): string {
  const trimmed = text(value, limit, name);
  if (!trimmed) throw new InboxLimitError(limit, `${name} is required.`);
  if (trimmed.length > max) {
    throw new InboxLimitError(limit, `${name} is ${trimmed.length} characters; at most ${max}.`);
  }
  return trimmed;
}

/** An optional string of at most `max` characters after trimming; empty becomes null. */
function optional(
  value: unknown,
  max: number,
  limit: InboxLimitError['limit'],
  name: string
): string | null {
  const trimmed = text(value, limit, name);
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new InboxLimitError(limit, `${name} is ${trimmed.length} characters; at most ${max}.`);
  }
  return trimmed;
}

/**
 * Check a decision's key: the extension's own, namespaced by core.
 *
 * @param key - The key as given.
 */
export function checkKey(key: unknown): string {
  if (typeof key !== 'string' || !DECISION_KEY_PATTERN.test(key)) {
    throw new InboxLimitError(
      'key',
      'A decision key is 1 to 128 letters, digits and ":._-", starting with a letter or digit.'
    );
  }
  return key;
}

/**
 * Check one in-app link an extension hands core.
 *
 * @param link - The link.
 * @param extensionId - The extension handing it over.
 * @param name - What the link is, for the message.
 */
function checkLink(link: unknown, extensionId: string, name: string): string | null {
  if (link === undefined || link === null) return null;
  if (!isAllowedExtensionLink(link, extensionId)) {
    throw new InboxLinkError(
      `${name} must be an in-app path: a DorkOS route or /x/${extensionId}/…. ` +
        `Nothing was written.`
    );
  }
  return link;
}

/** The actions, checked against their schema and the link rule. */
function checkActions(
  raw: unknown,
  extensionId: string
): { actions: DecisionActions; decideBy: string | null; defaultChoice: string | null } {
  const parsed = DecisionActionsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InboxLimitError(
      'choices',
      'actions must be yes-no, word, or a choice of 2 to 5 chips with labels of at most 40 characters.'
    );
  }
  const actions = parsed.data as DecisionActions;
  if (actions.kind === 'word') {
    if (actions.href !== undefined && actions.input === undefined) {
      checkLink(actions.href, extensionId, "A word action's href");
    }
    return { actions, decideBy: null, defaultChoice: null };
  }
  if (actions.kind !== 'choice') return { actions, decideBy: null, defaultChoice: null };

  const ids = actions.choices.map((choice) => choice.id);
  if (new Set(ids).size !== ids.length) {
    throw new InboxLimitError('choices', 'Every choice needs its own id.');
  }
  if (actions.defaultChoice !== undefined && !ids.includes(actions.defaultChoice)) {
    throw new InboxLimitError('choices', 'defaultChoice must be the id of one of the choices.');
  }
  if (actions.decideBy !== undefined && actions.defaultChoice === undefined) {
    throw new InboxLimitError(
      'decideBy',
      'decideBy needs a defaultChoice: the agent picks it then.'
    );
  }
  return { actions, decideBy: null, defaultChoice: actions.defaultChoice ?? null };
}

/**
 * Clamp a question's deadline (§7.1): earlier than `now` + 5 minutes (a past
 * one included) moves to `now` + 5 minutes; more than 7 days ahead throws.
 *
 * @param decideBy - The ISO time as given.
 * @param now - The raise time, in epoch ms.
 */
export function clampDecideBy(decideBy: string, now: number): string {
  const at = Date.parse(decideBy);
  if (Number.isNaN(at)) throw new InboxLimitError('decideBy', 'decideBy must be an ISO time.');
  if (at > now + DECIDE_BY_MAX_MS) {
    throw new InboxLimitError('decideBy', 'decideBy may be at most 7 days ahead.');
  }
  return new Date(Math.max(at, now + DECIDE_BY_MIN_MS)).toISOString();
}

/**
 * Check a whole `raise` input. Throws on any broken limit; writes nothing.
 *
 * @param input - What the extension passed.
 * @param extensionId - The raising extension.
 * @param now - The raise time, in epoch ms.
 */
export function checkDecisionInput(
  input: DecisionInput,
  extensionId: string,
  now: number
): CheckedDecision {
  if (typeof input !== 'object' || input === null) {
    throw new InboxLimitError('title', 'raise() needs a decision.');
  }
  const key = checkKey(input.key);
  const title = required(input.title, DECISION_LIMITS.title, 'title', 'title');
  const why = required(input.why, DECISION_LIMITS.why, 'why', 'why');
  const detail = optional(input.detail, DECISION_LIMITS.detail, 'detail', 'detail');
  const projectLabel = optional(
    input.projectLabel,
    DECISION_LIMITS.projectLabel,
    'title',
    'projectLabel'
  );
  const project = typeof input.project === 'string' && input.project ? input.project : null;
  const since =
    typeof input.since === 'string' && !Number.isNaN(Date.parse(input.since)) ? input.since : null;
  const link = checkLink(input.link, extensionId, 'link');
  const checked = checkActions(input.actions, extensionId);
  // Stored as asked: the clamped deadline lives beside it, so a re-raise of
  // the same question compares equal and never moves its deadline.
  const actions = checked.actions;
  let decideBy: string | null = null;
  if (actions.kind === 'choice' && actions.decideBy !== undefined) {
    decideBy = clampDecideBy(actions.decideBy, now);
  }
  return {
    key,
    title,
    why,
    detail,
    project,
    projectLabel,
    since,
    actions,
    link,
    decideBy,
    defaultChoice: checked.defaultChoice,
  };
}

/**
 * Check a `record` input's own parts: the reason and who decided are required.
 *
 * @param input - What the extension passed.
 * @param extensionId - The recording extension.
 */
export function checkRecordInput(
  input: Omit<DecisionInput, 'actions' | 'since'> & { choiceLabel?: string },
  extensionId: string
): Omit<CheckedDecision, 'actions' | 'since' | 'decideBy' | 'defaultChoice'> & {
  choiceLabel: string | null;
} {
  if (typeof input !== 'object' || input === null) {
    throw new InboxLimitError('title', 'record() needs a decision.');
  }
  return {
    key: checkKey(input.key),
    title: required(input.title, DECISION_LIMITS.title, 'title', 'title'),
    why: required(input.why, DECISION_LIMITS.why, 'why', 'why'),
    detail: optional(input.detail, DECISION_LIMITS.detail, 'detail', 'detail'),
    project: typeof input.project === 'string' && input.project ? input.project : null,
    projectLabel: optional(
      input.projectLabel,
      DECISION_LIMITS.projectLabel,
      'title',
      'projectLabel'
    ),
    link: checkLink(input.link, extensionId, 'link'),
    choiceLabel: optional(input.choiceLabel, DECISION_LIMITS.choiceWords, 'title', 'choiceLabel'),
  };
}

/**
 * Check who decided. Null when absent (the extension itself).
 *
 * @param by - The actor as given.
 */
export function checkActor(by: unknown): DecisionActor | null {
  if (by === undefined || by === null) return null;
  if (typeof by !== 'object') throw new InboxLimitError('title', 'by must be an object.');
  const actor = by as { kind?: unknown; label?: unknown };
  if (actor.kind === 'deadline') return { kind: 'deadline' };
  if (actor.kind === 'agent' || actor.kind === 'rule') {
    const label = required(actor.label, DECISION_LIMITS.actorLabel, 'title', 'by.label');
    return { kind: actor.kind, label };
  }
  throw new InboxLimitError('title', "by.kind must be 'agent', 'rule' or 'deadline'.");
}

/**
 * Check a follow-up offer. Null when absent or unusable; a bad one is dropped
 * rather than failing the answer it rides on.
 *
 * @param offer - The offer as given.
 */
export function checkOffer(offer: unknown): DecisionOffer | null {
  if (typeof offer !== 'object' || offer === null) return null;
  const o = offer as Partial<DecisionOffer>;
  if (typeof o.text !== 'string' || typeof o.offerId !== 'string') return null;
  const textValue = o.text.trim();
  if (!textValue || textValue.length > DECISION_LIMITS.offerText) return null;
  if (!o.offerId || o.offerId.length > DECISION_LIMITS.offerId) return null;
  const checked: DecisionOffer = { text: textValue, offerId: o.offerId };
  const patch = o.settingsPatch;
  if (
    patch &&
    typeof patch.project === 'string' &&
    patch.project &&
    typeof patch.patch === 'object' &&
    patch.patch !== null &&
    !Array.isArray(patch.patch)
  ) {
    // A patch that could never be written (over 16 KiB) makes the offer a
    // promise core cannot keep, so the whole offer is dropped up front.
    let size = Number.POSITIVE_INFINITY;
    try {
      size = Buffer.byteLength(JSON.stringify(patch.patch), 'utf8');
    } catch {
      /* not JSON: dropped below */
    }
    if (size > PROJECT_SETTINGS_MAX_BYTES) return null;
    checked.settingsPatch = { project: patch.project, patch: patch.patch };
  }
  return checked;
}

/**
 * Check a watched chat. Null when absent or malformed.
 *
 * @param watch - The watch as given.
 */
export function checkWatch(watch: unknown): DecisionWatch | null {
  if (typeof watch !== 'object' || watch === null) return null;
  const w = watch as Partial<DecisionWatch>;
  if (typeof w.sessionId !== 'string' || !w.sessionId || typeof w.label !== 'string') return null;
  const label = w.label.trim();
  if (!label || label.length > DECISION_LIMITS.watchLabel) return null;
  return { sessionId: w.sessionId, label };
}

/** A handler's `message`, trimmed and bounded, or null. */
function checkMessage(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  return trimmed ? trimmed.slice(0, 300) : null;
}

/**
 * Check what an action handler answered. Throws {@link HandlerAnswerError}
 * for an answer core cannot act on, which the caller treats exactly like a
 * handler that threw: the row stays open.
 *
 * @param result - The handler's answer.
 * @param extensionId - The extension that answered, for the link rule.
 */
export function checkActionResult(
  result: DecisionActionResult | undefined,
  extensionId: string
): CheckedActionResult {
  if (typeof result !== 'object' || result === null) {
    throw new HandlerAnswerError('The handler answered nothing core can act on.');
  }
  const r = result as Record<string, unknown>;
  if (r.settled === true) return { kind: 'settled' };
  const navigate =
    r.navigate === undefined || r.navigate === null
      ? null
      : isAllowedExtensionLink(r.navigate, extensionId)
        ? r.navigate
        : null;
  if (r.navigate !== undefined && r.navigate !== null && navigate === null) {
    throw new HandlerAnswerError('navigate must be an in-app path.');
  }
  if (r.keepOpen === true) {
    return {
      kind: 'keepOpen',
      navigate,
      message: checkMessage(r.message),
      watch: checkWatch(r.watch),
    };
  }
  if (r.resolve === 'approved' || r.resolve === 'rejected' || r.resolve === 'answered') {
    return {
      kind: 'resolve',
      outcome: r.resolve,
      navigate,
      offer: checkOffer(r.offer),
      message: checkMessage(r.message),
      watch: checkWatch(r.watch),
    };
  }
  throw new HandlerAnswerError('The handler must answer resolve, keepOpen or settled.');
}

/**
 * Check an answer against the decision's actions, and read what it carries.
 *
 * @param actions - How the decision may be answered.
 * @param request - The answer.
 */
export function shapeAnswer(
  actions: DecisionActions,
  request: DecisionActionRequest
):
  | {
      choiceId: string | null;
      choiceLabel: string | null;
      note: string | null;
      text: string | null;
    }
  | { refusal: string } {
  const note = request.note?.trim() || null;
  const typed = request.text?.trim() || null;
  switch (actions.kind) {
    case 'yes-no':
      if (request.action !== 'approve' && request.action !== 'reject') {
        return { refusal: 'This decision is answered with yes or no.' };
      }
      return {
        choiceId: null,
        choiceLabel: request.action === 'approve' ? actions.approveLabel : actions.rejectLabel,
        note: request.action === 'reject' ? note : null,
        text: null,
      };
    case 'word':
      if (request.action !== 'word') return { refusal: 'This decision has one button.' };
      if (!actions.input) {
        return { refusal: 'This button opens a page in the app; it is not sent here.' };
      }
      if (!typed) return { refusal: 'Type an answer first.' };
      if (typed.length > actions.input.maxLength) {
        return { refusal: `The answer is longer than ${actions.input.maxLength} characters.` };
      }
      return { choiceId: null, choiceLabel: actions.label, note: null, text: typed };
    case 'choice': {
      if (request.action !== 'choice')
        return { refusal: 'This decision is answered with a choice.' };
      if (request.choiceId) {
        const choice = actions.choices.find((c) => c.id === request.choiceId);
        if (!choice) return { refusal: 'That is not one of the choices.' };
        return { choiceId: choice.id, choiceLabel: choice.label, note: null, text: null };
      }
      if (actions.allowReply && typed) {
        return { choiceId: null, choiceLabel: 'Replied', note: null, text: typed };
      }
      return { refusal: 'Pick one of the choices.' };
    }
  }
}
