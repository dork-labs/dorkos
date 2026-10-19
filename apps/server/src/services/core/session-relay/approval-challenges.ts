/**
 * The challenges this computer issues for approving a tool call from the web
 * (spec `everything-is-a-space` B4, plan part 2).
 *
 * A challenge is a **statement** (`StepUpStatementV1` in `@dork-labs/cloud-api`):
 * exactly which chat, tool call and decision, the tool input this computer
 * holds and its hash, a nonce, two minutes to live, and the pinned passkeys.
 * The passkey signs `SHA-256` of the statement's bytes, so a hub that changes
 * one byte only gets a proof that fails here.
 *
 * Challenges live in memory, in a book per relay connection: one live
 * challenge per (chat, tool call, decision), at most
 * {@link MAX_LIVE_APPROVAL_CHALLENGES} at once, and each is taken out the
 * first time a proof names it, whether that proof passes or not. A book dies
 * with its connection, so a challenge never outlives the link it was issued on.
 *
 * @module services/core/session-relay/approval-challenges
 */
import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulidx';
import {
  STEP_UP_APPROVAL_STATEMENT_TYPE,
  StepUpStatementError,
  StepUpStatementV1Schema,
  encodeStepUpBase64url,
  encodeStepUpStatement,
  type StepUpStatementV1,
} from '@dork-labs/cloud-api';
import type { RelayResultBody } from '@dorkos/shared/session-relay';
import { hashApprovalInput } from '../approvals/approval-input-hash.js';
import type { ApprovalKeys } from './approval-key-store.js';

/** How long a challenge may be signed and answered. */
export const APPROVAL_CHALLENGE_TTL_MS = 120_000;

/** Most challenges one connection may hold live at once. */
export const MAX_LIVE_APPROVAL_CHALLENGES = 8;

/** The decision a challenge is bound to. */
export type ApprovalDecision = StepUpStatementV1['decision'];

/** The tool approval a chat is waiting on, as its pending card holds it. */
export interface PendingApprovalCard {
  /** The tool the agent asked to run. */
  toolName: string;
  /** The tool's friendlier name, when the runtime gave one. */
  displayName?: string;
  /** The tool input as the card holds it: JSON text, or raw text that is not JSON. */
  input: string;
}

/** What the relay's computer pin contributes to a statement. */
export interface ApprovalPinFacts {
  computerId: string;
  computerName: string;
  hubOrigin: string;
}

/** One challenge as this computer issued it, kept until a proof takes it. */
export interface IssuedApprovalChallenge {
  /** The statement as issued. */
  statement: StepUpStatementV1;
  /**
   * The WebAuthn challenge a proof must carry: base64url `SHA-256` of the
   * statement bytes, the same value `stepUpChallenge` computes.
   */
  expectedChallenge: string;
}

/** The live challenges of one relay connection. */
export interface ApprovalChallengeBook {
  /** By challenge id. */
  readonly live: Map<string, IssuedApprovalChallenge>;
}

/** What {@link issueApprovalChallenge} needs. */
export interface IssueApprovalChallengeInput {
  pin: ApprovalPinFacts;
  keys: ApprovalKeys;
  sessionId: string;
  toolCallId: string;
  decision: ApprovalDecision;
  pending: PendingApprovalCard;
  /** The current time; injectable for tests. */
  now?: Date;
}

/** A challenge issued, or why not. */
export type IssueApprovalChallengeResult =
  | {
      ok: true;
      /** The `interaction.challenge` result body. */
      body: RelayResultBody<'interaction.challenge'>;
      /** The hash of the input bound into it, for the audit log. */
      inputSha256: string;
    }
  | { ok: false; reason: 'too-large' | 'too-many' };

/**
 * A fresh, empty book for one connection.
 *
 * @returns A book with no live challenges.
 */
export function newApprovalChallengeBook(): ApprovalChallengeBook {
  return { live: new Map() };
}

/**
 * The tool input a pending card holds, as a value: parsed when it is JSON,
 * the raw text when it is not, `null` when there is none. Hashed the same way
 * at issue and at verify, so both read the card alike.
 *
 * @param raw - The card's `input` text.
 */
export function pendingApprovalInput(raw: string): unknown {
  try {
    return JSON.parse(raw) ?? null;
  } catch {
    return raw;
  }
}

/** A displayName goes into a statement only when the statement schema would take it. */
function signableDisplayName(displayName: string | undefined): string | undefined {
  if (displayName === undefined) return undefined;
  return StepUpStatementV1Schema.shape.displayName.safeParse(displayName).success
    ? displayName
    : undefined;
}

/** Drop expired challenges, and the live one for the same chat, tool call and decision. */
function prune(book: ApprovalChallengeBook, input: IssueApprovalChallengeInput, now: Date): void {
  for (const [id, issued] of book.live) {
    const { statement } = issued;
    const sameCard =
      statement.sessionId === input.sessionId &&
      statement.toolCallId === input.toolCallId &&
      statement.decision === input.decision;
    if (sameCard || now.getTime() >= Date.parse(statement.expiresAt)) book.live.delete(id);
  }
}

/**
 * Issue a challenge for one decision on one pending tool approval. Issuing
 * again for the same chat, tool call and decision replaces the live one.
 *
 * @param book - The connection's live challenges.
 * @param input - See {@link IssueApprovalChallengeInput}.
 * @returns The result body to answer with, or why none was issued: a
 *   statement this card cannot fit in (`too-large`), or a full book (`too-many`).
 */
export function issueApprovalChallenge(
  book: ApprovalChallengeBook,
  input: IssueApprovalChallengeInput
): IssueApprovalChallengeResult {
  const now = input.now ?? new Date();
  prune(book, input, now);
  if (book.live.size >= MAX_LIVE_APPROVAL_CHALLENGES) return { ok: false, reason: 'too-many' };

  const value = pendingApprovalInput(input.pending.input);
  let inputSha256: string;
  try {
    inputSha256 = hashApprovalInput(value);
  } catch {
    // Input nested past what the hash can walk: no statement could hold it either.
    return { ok: false, reason: 'too-large' };
  }
  const displayName = signableDisplayName(input.pending.displayName);
  const statement: StepUpStatementV1 = {
    t: STEP_UP_APPROVAL_STATEMENT_TYPE,
    challengeId: ulid(),
    computerId: input.pin.computerId,
    computerName: input.pin.computerName,
    hubOrigin: input.pin.hubOrigin,
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    decision: input.decision,
    toolName: input.pending.toolName,
    ...(displayName !== undefined ? { displayName } : {}),
    input: value as StepUpStatementV1['input'],
    inputSha256,
    nonce: randomBytes(32).toString('base64url'),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + APPROVAL_CHALLENGE_TTL_MS).toISOString(),
    rpId: input.keys.rpId,
    origin: input.keys.origin,
    credentialIds: input.keys.keys.map((key) => key.credentialId),
  };

  let bytes: Uint8Array;
  try {
    bytes = encodeStepUpStatement(statement);
  } catch (error) {
    if (error instanceof StepUpStatementError) return { ok: false, reason: 'too-large' };
    throw error;
  }
  // Hashed here, synchronously, so the cap check and this insert can never interleave.
  book.live.set(statement.challengeId, {
    statement,
    expectedChallenge: createHash('sha256').update(bytes).digest('base64url'),
  });
  return {
    ok: true,
    body: {
      challengeId: statement.challengeId,
      statement: encodeStepUpBase64url(bytes),
      expiresAt: statement.expiresAt,
    },
    inputSha256,
  };
}

/**
 * Take a challenge out of the book: the first proof that names it uses it up,
 * whether that proof passes or fails, so it can never be tried twice.
 *
 * @param book - The connection's live challenges.
 * @param challengeId - The id a proof names.
 * @returns The challenge, or `undefined` when there is none by that id.
 */
export function takeApprovalChallenge(
  book: ApprovalChallengeBook,
  challengeId: string
): IssuedApprovalChallenge | undefined {
  const issued = book.live.get(challengeId);
  book.live.delete(challengeId);
  return issued;
}
