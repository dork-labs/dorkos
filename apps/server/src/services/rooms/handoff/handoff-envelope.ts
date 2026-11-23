/** Strict versioned durable public handoff scope; structural decoding does not grant authority. */
import { createHash } from 'node:crypto';
import { stableStringify } from '@dorkos/shared/capabilities';
import { z } from 'zod';
import type {
  TurnPermissionBound,
  TurnPermissionCeiling,
  TurnPermissionLevel,
} from '@dorkos/shared/agent-runtime';
import type { AsideCarry } from '../room-trigger/aside.js';
import { joinSeatCarry } from './join-seat-carry.js';

// Shared contracts currently expose TypeScript shapes, not a reusable strict Zod decoder.
// Existing chat parseCeiling intentionally discards power bounds and catches corrupt input;
// it cannot authorize durable replay. These closed schemas implement the actual shared shape.
const identity = z.string().min(1);
const teammate = z.object({ roomId: identity, authorId: identity }).strict();
const level: z.ZodType<TurnPermissionLevel> = z
  .object({
    asks: z.enum(['always', 'when-risky', 'never']),
    reach: z.enum(['read', 'edit', 'workspace', 'everything']),
    auto: z.literal(true).optional(),
    outsider: z.literal(true).optional(),
    teammate: z.array(teammate).optional(),
  })
  .strict();
const bound: z.ZodType<TurnPermissionBound> = z.union([z.literal('runtime-default'), level]);
// An empty ceiling is restrictive/unknown in the runtime, but joinSeatCarry drops it.
// Quarantine it here until the carry join can preserve its exact semantics.
const ceiling: z.ZodType<TurnPermissionCeiling> = z.union([bound, z.array(bound).min(1)]);
const epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// The conservative fallback holds exactly one read/ask level. A runtime default or a bound
// list fails; `in` narrows the union, since Array.isArray cannot exclude a readonly array.
function isReadAskLevel(value: TurnPermissionCeiling | null): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'asks' in value &&
    value.asks === 'always' &&
    value.reach === 'read'
  );
}
const envelope = z
  .object({
    version: z.literal(2),
    // A recorded-transfer snapshot plus explicitly conservative word evidence.
    // Caller/session and current-token verification are separate server-owned admission facts.
    evidence: z
      .object({
        state: z.enum(['recorded-transfer', 'conservative-fallback']),
        wordEvidence: z.enum(['recorded', 'conservative']),
        sessionId: identity,
        turnSerial: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
      })
      .strict(),
    source: z.object({ id: identity, callerSessionId: identity, agentPath: identity }).strict(),
    recipient: z
      .object({
        sessionId: identity,
        createdAt: z.string().datetime({ offset: true }),
        agentId: identity,
        agentPath: identity,
        authorId: identity,
        runtime: identity,
        launchOrigin: identity.nullable(),
        requiredLaunchId: identity.nullable(),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    // Stored ledger scope is not verified native launch/billing evidence.
    seat: z
      .object({
        roomId: identity,
        authorId: identity,
        sessionId: identity,
        canonicalSessionId: identity,
        joinedAt: z.string().datetime({ offset: true }),
        agentPath: identity,
      })
      .strict(),
    enqueuedAt: epoch,
    waitDeadlineAt: epoch,
    carry: z
      .object({
        externalAuthor: z.boolean(),
        permissionCeiling: ceiling.nullable(),
        outsider: z.boolean(),
        outsideWords: z.boolean(),
        teammate: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((v, context) => {
    if (
      v.evidence.state === 'recorded-transfer'
        ? v.evidence.turnSerial === null
        : v.evidence.turnSerial !== null ||
          v.evidence.wordEvidence !== 'conservative' ||
          !v.carry.outsideWords ||
          !v.carry.outsider ||
          !v.carry.externalAuthor ||
          !isReadAskLevel(v.carry.permissionCeiling)
    )
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'Inconsistent admission evidence.',
      });
    const { digest, ...facts } = v.recipient;
    if (createHash('sha256').update(stableStringify(facts)).digest('hex') !== digest)
      context.addIssue({
        code: 'custom',
        path: ['recipient', 'digest'],
        message: 'Recipient digest is inconsistent.',
      });
    if (
      v.recipient.sessionId !== v.source.callerSessionId ||
      v.recipient.agentPath !== v.source.agentPath ||
      v.recipient.authorId !== v.seat.authorId
    )
      context.addIssue({
        code: 'custom',
        path: ['recipient'],
        message: 'Recipient differs from original admission.',
      });
    if (v.evidence.sessionId !== v.source.callerSessionId)
      context.addIssue({
        code: 'custom',
        path: ['evidence', 'sessionId'],
        message: 'Producer snapshot names a different source.',
      });
    if (v.waitDeadlineAt < v.enqueuedAt)
      context.addIssue({
        code: 'custom',
        path: ['waitDeadlineAt'],
        message: 'Original deadline precedes admission.',
      });
    if (v.source.agentPath !== v.seat.agentPath)
      context.addIssue({
        code: 'custom',
        path: ['seat', 'agentPath'],
        message: 'Source and seat agent differ.',
      });
  });

type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
export type HandoffEnvelope = DeepReadonly<z.infer<typeof envelope>>;
function freeze<T>(value: T): DeepReadonly<T> {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
/**
 * Structural decoding only, NOT producer attestation/replay authorization.
 * Throws on missing/unknown/corrupt data; never infers known-clean from empty marks.
 */
export function decodeHandoffEnvelope(json: string): HandoffEnvelope {
  return freeze(envelope.parse(JSON.parse(json) as unknown));
}
/** Also revalidates callers at the write boundary; JSON roundtrip detaches mutable originals. */
export function encodeHandoffEnvelope(value: HandoffEnvelope): string {
  return JSON.stringify(decodeHandoffEnvelope(JSON.stringify(value)));
}
/** Existing carry union owns semantics: every true flag and old/current bound survives. */
export function joinHandoffCurrentCarry(saved: HandoffEnvelope, current: AsideCarry): AsideCarry {
  // The existing join drops []; the runtime treats it as restrictive/unknown.
  // Refuse before joining rather than inventing an equivalent power bound.
  if (Array.isArray(current.permissionCeiling) && current.permissionCeiling.length === 0)
    throw new Error('Empty current ceiling is unsupported.');
  const carry = saved.carry;
  return joinSeatCarry(
    {
      externalAuthor: carry.externalAuthor,
      ...(carry.permissionCeiling !== null ? { permissionCeiling: carry.permissionCeiling } : {}),
      ...(carry.outsider ? { outsider: true as const } : {}),
      ...(carry.outsideWords ? { outsideWords: true as const } : {}),
      ...(carry.teammate ? { teammate: true as const } : {}),
    },
    current
  );
}
