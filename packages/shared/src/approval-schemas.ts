/**
 * Zod schemas for the approval primitive — the shape of a pending approval as
 * the cockpit sees it, and the two events that announce one (spec
 * `agent-trust` §3.3).
 *
 * Nothing here carries token material: a pending approval is safe to broadcast
 * to every connected client, and the secret the requester holds never appears
 * in an event, a list response, or a log line.
 *
 * @module shared/approval-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';
import { CAPABILITY_TIERS } from './capabilities.js';

extendZodWithOpenApiOnce();

/**
 * Longest summary an approval card will ever hold.
 *
 * A card has to be readable at a glance, and a requester supplies the sentence —
 * so the length is capped where it is stored rather than trusted at render time.
 * `ApprovalService.request` truncates to this, so a long summary shortens instead
 * of producing a row the cockpit cannot parse.
 */
export const APPROVAL_SUMMARY_MAX_LENGTH = 500;

/**
 * Longest {@link PendingApprovalSchema.shape.detail} an approval will hold.
 *
 * Sized off the biggest thing a capability can legitimately put there. Today
 * that is `NOPE_MAX_CHARS` (2,000), and the headroom is deliberate: a detail
 * that arrived truncated would recreate the very defect the field exists to fix,
 * so the cap has to sit clear of the largest declared payload rather than at it.
 * `ApprovalService.request` truncates to this, and a capability whose detail
 * field could exceed it must lower its own bound first.
 */
export const APPROVAL_DETAIL_MAX_LENGTH = 4000;

/**
 * Longest a resolved subject label may be.
 *
 * Matched to the requester label's cap, because the two are the same kind of
 * thing: a name a registry holds, which an agent can usually edit. Capping it
 * stops a self-chosen name from crowding the card.
 */
export const APPROVAL_SUBJECT_LABEL_MAX_LENGTH = 60;

/**
 * The kinds of thing an approval can act ON.
 *
 * Deliberately a closed set rather than a free string: each kind is a registry
 * the server can look a name up in, so adding one means writing the resolver
 * that makes it mean something. A kind with no resolver would render a heading
 * over an id, which is the defect this whole field exists to fix.
 */
export const APPROVAL_SUBJECT_KINDS = ['agent', 'task', 'room', 'connection'] as const;

/** What kind of thing an approval acts on. */
export type ApprovalSubjectKind = (typeof APPROVAL_SUBJECT_KINDS)[number];

/**
 * The thing an approval would act on, named.
 *
 * ## Why the id is here beside the label, and is not optional
 *
 * A label alone would be a worse card than a bare id, not a better one. Every
 * name this can carry comes from a registry an AGENT can write to — an agent's
 * `displayName` lives in its own `agent.json`, a schedule's name is whatever
 * created it — so an agent that wanted to disguise which agent it was deleting
 * could name itself after another one. The id is the part nothing can forge, so
 * the card shows both: the name to recognize, the id to check.
 *
 * The label is never taken from the caller's own arguments. It is read from the
 * registry that owns the id, using the id the caller supplied — so the worst a
 * caller can do is point at a different real thing, which the id then reveals.
 */
export const ApprovalSubjectSchema = z
  .object({
    /** Which registry the label came out of. */
    kind: z.enum(APPROVAL_SUBJECT_KINDS),
    /** The registry's own name for it. Never caller-supplied. */
    label: z.string().max(APPROVAL_SUBJECT_LABEL_MAX_LENGTH),
    /** The raw id the caller passed, shown so the name can be checked against it. */
    id: z.string().max(APPROVAL_SUBJECT_LABEL_MAX_LENGTH),
  })
  .openapi('ApprovalSubject');

/** The thing an approval would act on, named. */
export type ApprovalSubject = z.infer<typeof ApprovalSubjectSchema>;

/**
 * Where a request arrived from, when DorkOS could not tell WHO sent it.
 *
 * The honest half of an unattributed request. In-session identity is structural
 * — it resolves only when the session's working directory is a registered
 * agent's home — so an ordinary session in an ordinary project folder produces
 * no identity at all. That is correct behavior, but "an unidentified caller"
 * describes it as if the request came from nowhere, when the surface it came
 * over is known exactly.
 */
export const APPROVAL_ORIGINS = ['session', 'external-mcp'] as const;

/** Which surface a request arrived over. */
export type ApprovalOrigin = (typeof APPROVAL_ORIGINS)[number];

/**
 * An approval waiting on a person: what would run, why, and who asked. This is
 * exactly what the cockpit's approval card renders.
 */
export const PendingApprovalSchema = z
  .object({
    /** ULID identifying the approval. Carries no secret. */
    approvalId: z.string(),
    /** Capability the request would invoke, e.g. `marketplace.uninstall`. */
    capabilityId: z.string(),
    /** Human-facing capability title. */
    capabilityTitle: z.string(),
    /** Permission tier of the capability being requested. */
    tier: z.enum(CAPABILITY_TIERS),
    /** One plain sentence describing what would happen. */
    summary: z.string().max(APPROVAL_SUMMARY_MAX_LENGTH),
    /** Opaque label for who asked, when the request carried one. */
    requestedBy: z.string().optional(),
    /**
     * Whether DorkOS knows WHICH agent asked, and can therefore stop asking about
     * that agent doing this thing.
     *
     * The one bit a surface needs to decide whether to offer a standing
     * permission. It is not the same question as `requestedBy`, and the difference
     * is a trap worth naming: `requestedBy` is a display LABEL, and the marketplace
     * confirmation flow sets it on approvals that carry no agent path at all — so a
     * button drawn from `requestedBy` would appear on exactly the cards where
     * pressing it is refused.
     *
     * Necessary, not sufficient: the button also needs `approvals.standingGrants`
     * switched on, which is a setting rather than a property of one approval.
     *
     * Required rather than optional on purpose. An absent boolean reads as `false`
     * by accident, which would be right today and silently wrong the first time a
     * client forgot to send it.
     */
    hasAgentPath: z.boolean(),
    /** When the request was made. ISO 8601 UTC. */
    requestedAt: z.string(),
    /** When the request stops being honored. ISO 8601 UTC. */
    expiresAt: z.string(),
    /**
     * The one argument a person has to read IN FULL before answering, verbatim.
     *
     * Present only for a capability that declares `approvalDetailField` — one
     * today, the boundaries write, whose whole point is the text. Everything
     * else says what it needs to say in {@link summary}, and a card with no
     * detail renders exactly as it always has.
     *
     * Rendered as-is rather than as part of a sentence, so it carries no claim
     * about itself: it is the argument, shown, and the summary above says what
     * would be done with it. Like the summary it is swept for token-shaped runs
     * and capped ({@link APPROVAL_DETAIL_MAX_LENGTH}) where it is stored, never
     * at render time.
     */
    detail: z.string().max(APPROVAL_DETAIL_MAX_LENGTH).optional(),
    /**
     * The thing this would act on, named — when the server could name it.
     *
     * Absent is the honest answer, not a bug: an action with no opaque id has
     * nothing to resolve, and an id whose registry no longer holds it cannot be
     * named without inventing something. Either way the id itself is still in
     * {@link summary}, so a card without a subject says exactly what it always
     * said. A surface renders this ABOVE the summary and never INSTEAD of it.
     */
    subject: ApprovalSubjectSchema.optional(),
    /**
     * Which surface the request arrived over, when no agent identity resolved.
     *
     * Only ever set alongside an ABSENT {@link requestedBy}: once DorkOS knows
     * who asked, saying where it came from is noise. It exists so an
     * unattributed card can say the true thing it knows instead of the vague
     * one it used to.
     */
    origin: z.enum(APPROVAL_ORIGINS).optional(),
    /**
     * The arguments OTHER than the subject, rendered — present only alongside a
     * {@link subject}, and only when there are any.
     *
     * ## Why this exists rather than the card re-reading `summary`
     *
     * `summary` is one self-contained sentence, because a notification and an
     * Activity row have no card around them to supply the missing half. A CARD
     * does: it already draws the title as its heading, the requester on its own
     * line, and — once one resolves — the subject in bold. Rendering the whole
     * sentence underneath then says the title twice and the name twice, which is
     * a wall of text in the one place a person is trying to make a decision.
     *
     * So the card renders this instead, and it carries exactly what the card is
     * not already showing. Absent means there is nothing left to say, and the
     * card shows nothing rather than repeating itself.
     *
     * Bounded and swept identically to `summary`: it is built by the same
     * renderer, from the same allowlist, with the same per-value caps.
     */
    otherArguments: z.string().max(APPROVAL_SUMMARY_MAX_LENGTH).optional(),
  })
  .openapi('PendingApproval');

/** An approval waiting on a person. */
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;

/** Response body of `GET /api/approvals/pending`. */
export const PendingApprovalsResponseSchema = z
  .object({
    approvals: z.array(PendingApprovalSchema),
  })
  .openapi('PendingApprovalsResponse');

/** Response body of `GET /api/approvals/pending`. */
export type PendingApprovalsResponse = z.infer<typeof PendingApprovalsResponseSchema>;

/**
 * How a pending approval ended. `expired` is reported when a token is presented
 * after its window closed, so the cockpit can retire a stale card even though
 * nobody clicked anything.
 */
export const APPROVAL_OUTCOMES = ['granted', 'denied', 'expired', 'consumed'] as const;

/** How a pending approval ended. */
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number];

/**
 * How an IN-SESSION capability approval hold ended (DOR-939).
 *
 * `granted`/`denied` are an operator decision the held call resumed on; `expired`/
 * `timeout` are the no-decision paths that degrade the held call back to today's
 * `approval_required` poll payload (`expired`: the token's own window closed;
 * `timeout`: the hold's own cap elapsed, or its abort signal fired first). It is
 * a superset of {@link APPROVAL_OUTCOMES}' relevant members, kept distinct
 * because a hold can end for reasons the token lifecycle has no word for.
 */
export const CAPABILITY_APPROVAL_OUTCOMES = ['granted', 'denied', 'expired', 'timeout'] as const;

/** How an in-session capability approval hold ended. */
export const CapabilityApprovalOutcomeSchema = z.enum(CAPABILITY_APPROVAL_OUTCOMES);

/** How an in-session capability approval hold ended. */
export type CapabilityApprovalOutcome = (typeof CAPABILITY_APPROVAL_OUTCOMES)[number];

/** Request body of `POST /api/approvals/:id/grant`. */
export const GrantApprovalBodySchema = z
  .object({
    /**
     * Also stop being asked about this agent doing this thing, for as long as
     * `approvals.trustWindowMinutes` says.
     *
     * Needs a person signed in to DorkOS, so it needs Require login to be on: with
     * login off there is no cookie, and DorkOS cannot tell the operator from an
     * agent running as the same user. It is refused, never quietly downgraded to a
     * plain one-time yes — a caller that asked for two things is told which one
     * failed, because a silent fallback would leave a person believing they created
     * a permission that does not exist.
     */
    standing: z.boolean().optional(),
  })
  .openapi('GrantApprovalBody');

/** Request body of `POST /api/approvals/:id/grant`. */
export type GrantApprovalBody = z.infer<typeof GrantApprovalBodySchema>;

/** Request body of `POST /api/approvals/:id/deny`. */
export const DenyApprovalBodySchema = z
  .object({
    /** Optional note the requester sees instead of a bare refusal. */
    reason: z.string().max(1024).optional(),
  })
  .openapi('DenyApprovalBody');

/** Request body of `POST /api/approvals/:id/deny`. */
export type DenyApprovalBody = z.infer<typeof DenyApprovalBodySchema>;

/**
 * One live standing permission, as the cockpit lists it.
 *
 * A permission a person cannot find is a dark pattern, so everything the two
 * surfaces that list one actually render is here: which agent, which action, and
 * when it runs out — plus the id the Stop-trusting button acts on.
 *
 * ## What is deliberately NOT here
 *
 * Who opened it, when, under which posture, and which card it came from. All four
 * are recorded — in the row and in the `approval.grant_created` Activity event, which
 * is where an audit question belongs — and none of them is rendered anywhere. A
 * response that carried them would be handing out the operator's account id to
 * answer a question nobody asked.
 */
export const StandingPermissionSchema = z
  .object({
    /** ULID identifying the permission. Carries no secret. */
    grantId: z.string(),
    /**
     * Absolute path to the agent's project directory — the stable key.
     *
     * Kept, unlike the fields above, because {@link agentLabel} is a folder name and
     * two agents can share one. `--path` is required when an agent is created and
     * nothing uniques an agent's NAME (only its path), so `--path ~/work/acme/helper`
     * and `--path ~/work/beta/helper` are both allowed and both read as "helper". A
     * list that cannot tell them apart is not a list a person can act on.
     */
    agentPath: z.string(),
    /** The agent's directory name, which is the handle a person recognizes. */
    agentLabel: z.string(),
    /** The one action this covers, e.g. `marketplace.uninstall`. */
    capabilityId: z.string(),
    /** Human-facing title for that action, falling back to its id. */
    capabilityTitle: z.string(),
    /** When it stops working. ISO 8601 UTC. Absolute, and never extended by use. */
    expiresAt: z.string(),
  })
  .openapi('StandingPermission');

/** One live standing permission, as the cockpit lists it. */
export type StandingPermission = z.infer<typeof StandingPermissionSchema>;

/** Response body of `GET /api/approvals/grants`. */
export const StandingPermissionsResponseSchema = z
  .object({
    grants: z.array(StandingPermissionSchema),
  })
  .openapi('StandingPermissionsResponse');

/** Response body of `GET /api/approvals/grants`. */
export type StandingPermissionsResponse = z.infer<typeof StandingPermissionsResponseSchema>;

/** Response body of `DELETE /api/approvals/grants/:id`. */
export const RevokeStandingPermissionResponseSchema = z
  .object({
    ok: z.literal(true),
    /** ULID of the permission that was ended. */
    grantId: z.string(),
  })
  .openapi('RevokeStandingPermissionResponse');

/** Response body of `DELETE /api/approvals/grants/:id`. */
export type RevokeStandingPermissionResponse = z.infer<
  typeof RevokeStandingPermissionResponseSchema
>;

/**
 * What `POST /api/approvals/:id/grant` answers when the one-time yes was recorded
 * but the standing permission was not.
 *
 * Its own schema rather than the generic error body, because the two extra fields
 * are the whole point: they say which half happened. A caller reading a bare error
 * cannot tell this from "nothing happened", and retrying the call would answer 409,
 * which reads like the permission exists.
 */
export const StandingPermissionNotRecordedResponseSchema = z
  .object({
    /** One plain sentence saying which half happened. */
    error: z.string(),
    /** Discriminator. Always `STANDING_PERMISSION_NOT_RECORDED`. */
    code: z.literal('STANDING_PERMISSION_NOT_RECORDED'),
    /** ULID of the approval that WAS granted. */
    approvalId: z.string(),
    /** The decision that was recorded, so the caller knows the action may proceed once. */
    outcome: z.literal('granted'),
  })
  .openapi('StandingPermissionNotRecordedResponse');

/** Response body when the permission could not be recorded. */
export type StandingPermissionNotRecordedResponse = z.infer<
  typeof StandingPermissionNotRecordedResponseSchema
>;

/** Response body of the grant and deny endpoints. */
export const ApprovalDecisionResponseSchema = z
  .object({
    ok: z.literal(true),
    /** ULID of the approval that was decided. */
    approvalId: z.string(),
    /** The decision that was recorded. */
    outcome: z.enum(['granted', 'denied']),
    /**
     * The standing permission this decision also opened, when the caller asked for
     * one with `standing: true`.
     *
     * Present only on success. A request that asked for a permission and could not
     * have one is refused outright rather than answered with this field missing,
     * because "look for an absent field" is not how a person learns they did not get
     * what they asked for.
     */
    standingPermission: StandingPermissionSchema.optional(),
  })
  .openapi('ApprovalDecisionResponse');

/** Response body of the grant and deny endpoints. */
export type ApprovalDecisionResponse = z.infer<typeof ApprovalDecisionResponseSchema>;
