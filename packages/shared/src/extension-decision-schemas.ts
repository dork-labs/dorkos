/**
 * The wire shapes for an extension's decisions in the inbox (spec
 * `flow-multiproject` §7, phase 2b; DOR-2523).
 *
 * An extension asks a person something through `ctx.inbox.raise` on the
 * server. Core owns everything after that: the one open row per key, the
 * `extension.decision` notification kind, the escalation clock, a question's
 * deadline, and who ends up deciding. These are the shapes the bell, the
 * inbox and an extension's own pages read and answer them in.
 *
 * Every limit below is enforced on the server (`services/extensions/
 * extension-inbox.ts`) and the ones a person types against are checked again
 * in the client, so an answer that is too long is refused before it leaves
 * the page.
 *
 * @module shared/extension-decision-schemas
 */
import { z } from 'zod';
import { ProjectRefSchema } from './project-schemas.js';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/** The characters a decision key may hold. Core namespaces it by the extension's id. */
export const DECISION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

/** The limits on what a decision says and what a person answers (§7.1). */
export const DECISION_LIMITS = {
  /** A question or an outcome, in plain words. */
  title: 120,
  /** The required second line: what happens, why now, what "no" means. */
  why: 300,
  /** Shown behind ⓘ. */
  detail: 500,
  /** A "Needs changes" note or a typed answer. */
  note: 2000,
  /** One choice chip's label. */
  choiceLabel: 40,
  /** Fewest choices a question may offer. */
  minChoices: 2,
  /** Most choices a question may offer. */
  maxChoices: 5,
  /** Most open decisions one extension may hold at once. */
  open: 50,
  /** The project heading's muted right-hand label ("Linear DOR"). */
  projectLabel: 60,
  /** The one-time follow-up offer's text. */
  offerText: 160,
  /** The offer's own id, which comes back to the extension on "Yes". */
  offerId: 64,
  /** "Sorting 12 ideas…" on a watched chat. */
  watchLabel: 40,
  /** Who decided, in words ("the reviewer agent"). */
  actorLabel: 60,
  /** What was chosen, in words ("Shipped"). */
  choiceWords: 40,
} as const;

/** How soon a question's deadline may be: anything earlier is moved to raise + 5 minutes. */
export const DECIDE_BY_MIN_MS = 5 * 60 * 1000;

/** How far ahead a question's deadline may be. */
export const DECIDE_BY_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a one-time follow-up offer stays answerable. */
export const DECISION_OFFER_TTL_MS = 15 * 60 * 1000;

/** The largest per-project settings value core keeps for an extension (§7.10). */
export const PROJECT_SETTINGS_MAX_BYTES = 16 * 1024;

/** `409` when the extension that raised the decision is not running. */
export const DECISION_NOT_RUNNING_CODE = 'not_running';

/** `409` when the decision was settled before this answer landed. */
export const DECISION_ALREADY_RESOLVED_CODE = 'already_resolved';

/** `504` when the extension did not answer within its 5 seconds. */
export const DECISION_EXTENSION_TIMEOUT_CODE = 'extension_timeout';

/** `409` when the question changed after the person saw it. */
export const DECISION_STALE_CODE = 'stale_decision';

/** `409` when a follow-up offer was used, dismissed, or is too old. */
export const DECISION_OFFER_GONE_CODE = 'offer_gone';

/** One choice chip of a question. */
export const DecisionChoiceSchema = z
  .object({
    /** The extension's id for this choice. */
    id: z.string().min(1).max(64),
    /** What the chip says. */
    label: z.string().min(1).max(DECISION_LIMITS.choiceLabel),
  })
  .openapi('DecisionChoice');

/** How a person can answer a decision. */
export const DecisionActionsSchema = z
  .discriminatedUnion('kind', [
    z.object({
      /** 👎 and 👍, each labelled as its outcome. */
      kind: z.literal('yes-no'),
      approveLabel: z.string().min(1).max(40),
      rejectLabel: z.string().min(1).max(40),
      /** 👎 opens a short note ("What needs to change?") before it sends. */
      rejectAsksForNote: z.boolean().optional(),
    }),
    z.object({
      /** One small text button. */
      kind: z.literal('word'),
      label: z.string().min(1).max(40),
      /** An in-app path to open; ignored when `input` is set. */
      href: z.string().min(1).optional(),
      /** An inline text field whose text reaches the extension. */
      input: z
        .object({
          placeholder: z.string().max(80),
          maxLength: z.number().int().min(1).max(DECISION_LIMITS.note),
        })
        .optional(),
    }),
    z.object({
      /** A question: chips, the agent's pick marked, and maybe a deadline. */
      kind: z.literal('choice'),
      choices: z
        .array(DecisionChoiceSchema)
        .min(DECISION_LIMITS.minChoices)
        .max(DECISION_LIMITS.maxChoices),
      /** The agent's pick, marked "agent's pick". */
      defaultChoice: z.string().min(1).optional(),
      /** ISO time the agent's pick is applied when nobody answered. */
      decideBy: z.string().optional(),
      /** Offer "Reply…" with free text. */
      allowReply: z.boolean().optional(),
    }),
  ])
  .openapi('DecisionActions');

/** How a person can answer a decision. */
export type DecisionActions = z.infer<typeof DecisionActionsSchema>;

/** A chat an extension started, drawn on the row as "Sorting 12 ideas… · Watch". */
export const DecisionWatchSchema = z
  .object({
    sessionId: z.string().min(1),
    label: z.string().min(1).max(DECISION_LIMITS.watchLabel),
  })
  .openapi('DecisionWatch');

/** A chat an extension started, drawn on the row. */
export type DecisionWatch = z.infer<typeof DecisionWatchSchema>;

/** One open decision, as the inbox and the extension's own pages see it. */
export const ExtensionDecisionDTOSchema = z
  .object({
    /** Core's id for the row. */
    id: z.string().min(1),
    /** The extension that raised it. */
    extensionId: z.string().min(1),
    /** Its manifest name as core knows it: the row's mono source line. Never the extension's own text. */
    extensionName: z.string().min(1),
    /** The extension's own key, unique among its open decisions. */
    key: z.string().min(1),
    /** A question or an outcome. */
    title: z.string().min(1),
    /** What happens, why now, what "no" means. */
    why: z.string().min(1),
    /** Shown behind ⓘ, or null. */
    detail: z.string().nullable(),
    /** The project it belongs to, or null. */
    project: ProjectRefSchema.nullable(),
    /** The project heading's muted right-hand label, or null. */
    projectLabel: z.string().nullable(),
    /** When the condition began, or null. */
    since: z.string().nullable(),
    /**
     * How to answer it. A question whose deadline already passed, and which the
     * extension kept open, has no `decideBy` here any more: its deadline line
     * goes away.
     */
    actions: DecisionActionsSchema,
    /** In-app path the title opens, or null. */
    link: z.string().nullable(),
    /** When it was first raised. */
    raisedAt: z.string(),
    /**
     * True once the agent's pick could not be applied at the deadline (after
     * its retries): the row says "The agent couldn't go ahead. It needs you."
     */
    needsYou: z.boolean(),
    /** A chat the extension started about this, or null. */
    watch: DecisionWatchSchema.nullable(),
    /**
     * Bumped whenever the extension changes what is asked. Send it back with
     * an answer so an answer to an older version is refused, not applied.
     */
    revision: z.number().int().min(0),
  })
  .openapi('ExtensionDecision');

/** One open decision. */
export type ExtensionDecisionDTO = z.infer<typeof ExtensionDecisionDTOSchema>;

/** A one-time follow-up offer still waiting for the person who answered. */
export const PendingDecisionOfferSchema = z
  .object({
    /** The decision it follows (also the history row's subject id). */
    decisionId: z.string().min(1),
    /** "Shipped. Next time, ship on its own when the reviewer agent approves?" */
    text: z.string().min(1).max(DECISION_LIMITS.offerText),
    /** When it stops being answerable. */
    expiresAt: z.string(),
  })
  .openapi('PendingDecisionOffer');

/** A one-time follow-up offer. */
export type PendingDecisionOffer = z.infer<typeof PendingDecisionOfferSchema>;

/** Query of `GET /api/extension-decisions`. */
export const ListExtensionDecisionsQuerySchema = z
  .object({
    /** Only this extension's decisions. */
    extensionId: z.string().min(1).optional(),
  })
  .openapi('ListExtensionDecisionsQuery');

/** Response of `GET /api/extension-decisions` and `GET /api/extensions/:id/decisions`. */
export const ListExtensionDecisionsResponseSchema = z
  .object({
    /** Open decisions of running extensions, oldest first. */
    decisions: z.array(ExtensionDecisionDTOSchema),
    /**
     * Follow-up offers a person has not answered yet, for an answer an
     * extension settled later (`resolve` with `answering`). An offer made in
     * reply to an answer is not listed: it comes back with that answer, to the
     * one client that gave it. Empty on the extension-scoped route.
     */
    offers: z.array(PendingDecisionOfferSchema),
  })
  .openapi('ListExtensionDecisionsResponse');

/** Response of the decision list routes. */
export type ListExtensionDecisionsResponse = z.infer<typeof ListExtensionDecisionsResponseSchema>;

/** Body of the two answer routes. */
export const DecisionActionRequestSchema = z
  .object({
    action: z.enum(['approve', 'reject', 'word', 'choice']),
    /** The "Needs changes" note, for a `reject`. */
    note: z.string().max(DECISION_LIMITS.note).optional(),
    /** A typed answer: a `word` field, or a question's "Reply…". */
    text: z.string().max(DECISION_LIMITS.note).optional(),
    /** The chosen chip, for a `choice`. */
    choiceId: z.string().min(1).optional(),
    /** The revision the person saw; an older one is refused (`stale_decision`). */
    revision: z.number().int().min(0).optional(),
  })
  .openapi('DecisionActionRequest');

/** Body of the two answer routes. */
export type DecisionActionRequest = z.infer<typeof DecisionActionRequestSchema>;

/** Response of the two answer routes. */
export const DecisionActionResponseSchema = z
  .object({
    /** Whether the answer settled it. False when the extension kept it open. */
    resolved: z.boolean(),
    /** Something the extension wants the person told, as a toast. */
    message: z.string().nullable(),
    /** An in-app path the client should open, already checked. */
    navigate: z.string().nullable(),
    /** The one-time "next time, on its own?" offer. Only ever for a person's answer in core's UI. */
    offer: z.object({ text: z.string() }).nullable(),
    /** A chat the extension started about it. */
    watch: DecisionWatchSchema.nullable(),
  })
  .openapi('DecisionActionResponse');

/** Response of the two answer routes. */
export type DecisionActionResponse = z.infer<typeof DecisionActionResponseSchema>;

/** Body of `POST /api/extension-decisions/:id/offer`. */
export const DecisionOfferRequestSchema = z
  .object({
    /** Yes, or a quiet dismiss. */
    accept: z.boolean(),
  })
  .openapi('DecisionOfferRequest');

/** Response of `POST /api/extension-decisions/:id/offer`. */
export const DecisionOfferResponseSchema = z
  .object({
    /** What the extension said back ("Done. Change it any time in Flow settings."). */
    message: z.string().nullable(),
  })
  .openapi('DecisionOfferResponse');

/** Response of `POST /api/extension-decisions/:id/offer`. */
export type DecisionOfferResponse = z.infer<typeof DecisionOfferResponseSchema>;

/** Who last wrote one project's settings for an extension (§7.10). */
export const PROJECT_SETTINGS_WRITERS = ['person', 'extension-page'] as const;

/** Query of `GET /api/extensions/:id/project-settings`. */
export const ProjectSettingsQuerySchema = z
  .object({
    /** Any folder inside the project. */
    project: z.string().min(1),
  })
  .openapi('ProjectSettingsQuery');

/** Response of `GET /api/extensions/:id/project-settings`. */
export const ProjectSettingsResponseSchema = z
  .object({
    /** The stored value, or null when nobody set one. */
    value: z.unknown().nullable(),
    /** When it was last written, or null. */
    updatedAt: z.string().nullable(),
    /** Who last wrote it, or null. */
    updatedBy: z.enum(PROJECT_SETTINGS_WRITERS).nullable(),
  })
  .openapi('ProjectSettingsResponse');

/** Response of `GET /api/extensions/:id/project-settings`. */
export type ProjectSettingsResponse = z.infer<typeof ProjectSettingsResponseSchema>;

/** Body of `PUT /api/extensions/:id/project-settings`. */
export const PutProjectSettingsRequestSchema = z
  .object({
    /** Any folder inside the project. */
    project: z.string().min(1),
    /** Any JSON, at most 16 KiB once written. */
    value: z.unknown(),
  })
  .openapi('PutProjectSettingsRequest');

// --- Starting work in a new chat (spec §7.7) --------------------------------

/** The limits on what starting work takes, and on how often (§7.7). */
export const START_WORK_LIMITS = {
  /** The first message, sent at once. */
  prompt: 20_000,
  /** The chat's title, plain words. */
  title: 80,
  /** Why it was started, shown as the chat's first line. */
  reason: 200,
  /** Most chats one extension may start in a rolling hour (its chats' chats included). */
  perHour: 10,
  /** Most of its started chats that may be running a turn at once. */
  running: 3,
} as const;

/** Why a start was refused. Shared by `api.startWork` and `ctx.sessions.start`. */
export const START_WORK_ERROR_CODES = [
  'not_a_project',
  'account_not_allowed_here',
  'start_limit',
] as const;

/** One of {@link START_WORK_ERROR_CODES}. */
export type StartWorkErrorCode = (typeof START_WORK_ERROR_CODES)[number];

/** Body of `POST /api/extensions/:id/start-work` (what `api.startWork` sends). */
export const StartWorkRequestSchema = z
  .object({
    /** Any folder inside a known project; the chat runs in the project root. */
    project: z.string().min(1),
    /** Sent at once as the chat's first message. */
    prompt: z.string().trim().min(1).max(START_WORK_LIMITS.prompt),
    /** The chat's title, plain words. */
    title: z.string().trim().min(1).max(START_WORK_LIMITS.title),
    /** Why it was started, shown as the chat's first line. */
    reason: z.string().trim().min(1).max(START_WORK_LIMITS.reason),
  })
  .openapi('StartWorkRequest');

/** Body of `POST /api/extensions/:id/start-work`. */
export type StartWorkRequest = z.infer<typeof StartWorkRequestSchema>;

/** Response of `POST /api/extensions/:id/start-work`. */
export const StartWorkResponseSchema = z
  .object({
    /** The new chat: open it at `/session?session=<sessionId>`. */
    sessionId: z.string(),
  })
  .openapi('StartWorkResponse');

/** Response of `POST /api/extensions/:id/start-work`. */
export type StartWorkResponse = z.infer<typeof StartWorkResponseSchema>;

/** A refused start: the sentence to show, and which rule refused it. */
export const StartWorkErrorResponseSchema = z
  .object({
    /** Plain words, safe to show as they are. */
    error: z.string(),
    /** Which rule refused it. */
    code: z.enum(START_WORK_ERROR_CODES),
  })
  .openapi('StartWorkErrorResponse');
