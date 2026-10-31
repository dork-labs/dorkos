/**
 * "Confirm it's you": the step-up a person passes before one sensitive action
 * runs (DOR-3234). Unlike the once-per-browser confirmation in
 * `./person-session.ts`, this is per action: each proof covers exactly one
 * held action, once, for two minutes.
 *
 * The flow, end to end:
 *
 * 1. The app asks for a guarded action. The server does not run it: it holds
 *    it, and answers `428` with {@link STEP_UP_REQUIRED_CODE} and the held
 *    action's id ({@link StepUpRequiredBody}).
 * 2. The app reads the held action ({@link HeldStepUpView}): the sentence the
 *    server wrote about what will actually run, and how it may be confirmed.
 *    The app never sends the action itself, or its hash, again.
 * 3. The person confirms with their password ({@link StepUpPasswordBody}).
 *    Only once it passes does the server run the action it held, and it
 *    answers with that action's own result ({@link StepUpConfirmedBody}).
 *    A failed, cancelled or expired step-up writes nothing.
 *
 * The statement ({@link LocalStepUpStatementV1}) is what a held action is
 * bound to, and what a passkey will sign later. It never leaves this
 * computer, so it lives here, not in `@dork-labs/cloud-api`; its `t` and
 * `purpose` keep it apart from the relay's approval statement, and each
 * verifier refuses the other's.
 *
 * @module shared/step-up
 */
import { z } from 'zod';

/** The base path of the step-up routes. */
export const STEP_UP_PATH = '/api/step-up';

/** The code a guarded action answers with while it waits for a step-up. */
export const STEP_UP_REQUIRED_CODE = 'step_up_required';

/** The statement type of a local step-up, distinct from the relay's approval statement. */
export const LOCAL_STEP_UP_STATEMENT_TYPE = 'dorkos.local.step-up.v1';

/** How long a held action waits for its step-up. */
export const STEP_UP_TTL_MS = 120_000;

/** The wrong passwords one held action takes before it is dropped. */
export const STEP_UP_MAX_PASSWORD_TRIES = 5;

/**
 * The actions a step-up guards (DOR-3212 threat model, plus DOR-3271's
 * Confirm). A new one is added here first, so every statement names a kind
 * the server knows.
 */
export const STEP_UP_ACTION_KINDS = [
  /** Allow an MCP server for every agent (DOR-3213). */
  'mcp-server.allow-global',
  /** Turn on the person's own browser for agents (DOR-3214). */
  'own-browser.enable',
  /** Add a site an agent may use in the person's own browser (DOR-3214). */
  'own-browser.add-site',
  /** Show a pairing code (DOR-3216). */
  'pairing-code.show',
  /** Bind a browser profile (DOR-3216). */
  'browser-profile.bind',
  /** Confirm a paused connection's setting (DOR-3271). */
  'connection.confirm-setting',
] as const;

/** One kind of guarded action. */
export const StepUpActionKindSchema = z.enum(STEP_UP_ACTION_KINDS);

/** One kind of guarded action. */
export type StepUpActionKind = z.infer<typeof StepUpActionKindSchema>;

/** The ways a step-up can be passed. Passkeys follow (DOR-3234 PR 3). */
export const StepUpMethodSchema = z.enum(['password']);

/** One way a step-up can be passed. */
export type StepUpMethod = z.infer<typeof StepUpMethodSchema>;

/**
 * What a held action is bound to: the action, the hash of exactly what will
 * run, and a nonce, for two minutes. Built and kept by the server only.
 */
export const LocalStepUpStatementV1Schema = z
  .object({
    t: z.literal(LOCAL_STEP_UP_STATEMENT_TYPE),
    purpose: z.literal('step-up'),
    /** The held action's id. */
    heldActionId: z.string().min(1).max(64),
    kind: StepUpActionKindSchema,
    /** What the action acts on, in the server's words (a server name, a site). */
    target: z.string().min(1).max(512),
    /** SHA-256 hex of the canonical action: kind, target and input. */
    inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** 32 random bytes, base64url. */
    nonce: z.string().min(43).max(64),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

/** What a held action is bound to. */
export type LocalStepUpStatementV1 = z.infer<typeof LocalStepUpStatementV1Schema>;

/** What a guarded action answers while it waits for a step-up. */
export const StepUpRequiredBodySchema = z.object({
  error: z.string(),
  code: z.literal(STEP_UP_REQUIRED_CODE),
  /** The held action to read and confirm. */
  heldActionId: z.string().min(1),
  expiresAt: z.string().datetime(),
});

/** What a guarded action answers while it waits for a step-up. */
export type StepUpRequiredBody = z.infer<typeof StepUpRequiredBodySchema>;

/** Why a held action cannot be confirmed by password from here, if it cannot. */
export const StepUpPasswordUnavailableSchema = z.enum([
  /** Plain HTTP from another device: the password would cross the network in the clear. */
  'insecure-connection',
  /** No owner account, or the owner has no password. */
  'no-password',
]);

/** Why a held action cannot be confirmed by password from here. */
export type StepUpPasswordUnavailable = z.infer<typeof StepUpPasswordUnavailableSchema>;

/** A held action, as the sheet shows it. Every sentence is the server's. */
export const HeldStepUpViewSchema = z.object({
  heldActionId: z.string().min(1),
  kind: StepUpActionKindSchema,
  /** What will actually run, e.g. "Confirm it's you to add github (`@modelcontextprotocol/server-github`) for all your agents." */
  reason: z.string().min(1),
  /** Quiet extra lines, e.g. "Not pinned to a version. What runs can change later." */
  notes: z.array(z.string().min(1)),
  expiresAt: z.string().datetime(),
  /** The ways this caller may confirm it, in the order to offer them. Empty when none. */
  methods: z.array(StepUpMethodSchema),
  /** Why the password is not offered, when it is not. */
  passwordUnavailable: StepUpPasswordUnavailableSchema.optional(),
  /** Wrong passwords left before the held action is dropped. */
  triesLeft: z.number().int().min(0),
});

/** A held action, as the sheet shows it. */
export type HeldStepUpView = z.infer<typeof HeldStepUpViewSchema>;

/** The body of a password confirm. */
export const StepUpPasswordBodySchema = z.object({
  /** The owner's password. Never logged or stored. */
  password: z.string().min(1).max(1024),
});

/** The body of a password confirm. */
export type StepUpPasswordBody = z.infer<typeof StepUpPasswordBodySchema>;

/**
 * The body of change-and-confirm, for an owner whose password is shorter than
 * the minimum: the current one is checked first, then replaced, then the held
 * action runs.
 */
export const StepUpChangePasswordBodySchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024),
});

/** The body of change-and-confirm. */
export type StepUpChangePasswordBody = z.infer<typeof StepUpChangePasswordBodySchema>;

/**
 * What a passed step-up answers: the held action ran, and this is its own
 * answer, status and body, as if it had run when first asked.
 */
export const StepUpConfirmedBodySchema = z.object({
  ok: z.literal(true),
  /** The held action's own HTTP status. */
  status: z.number().int().min(200).max(599),
  /** The held action's own response body. */
  result: z.unknown(),
});

/** What a passed step-up answers. */
export type StepUpConfirmedBody = z.infer<typeof StepUpConfirmedBodySchema>;

/** Why a step-up was refused, as `code` on its error body. */
export const STEP_UP_REFUSAL_CODES = [
  /** No such held action, or it already ran, expired or was cancelled. */
  'expired',
  'wrong-password',
  /** The held action took its last wrong password and was dropped. */
  'too-many-tries',
  /** Too many wrong passwords lately, from anywhere: wait, then try again. */
  'too-many-attempts',
  /** The password matched but is shorter than the minimum: change it to go on. */
  'password-too-short',
  /** A new password that is too short or too long. */
  'new-password-invalid',
  'no-password',
  'insecure-connection',
  /** Not the app's own page, or a program rather than a person. */
  'not-a-person',
  /** Another browser held this action. */
  'not-your-action',
] as const;

/** Why a step-up was refused. */
export type StepUpRefusalCode = (typeof STEP_UP_REFUSAL_CODES)[number];
