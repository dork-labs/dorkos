/**
 * The work-claim tools (DOR-4019): `work_claim`, `work_claim_check` and
 * `work_claim_release`. A chat claims a key before it takes on a job, so the
 * same agent's other chats see the job is taken and leave it.
 *
 * The agent and the chat always come from the verified turn, never from input,
 * so a chat can only ever claim, read or release its own agent's claims. A
 * holder the caller may not read (a person's private chat with this agent) is
 * named only as "a private chat": no title, no link.
 *
 * @module services/session/claims/work-claim-capabilities
 */
import { z } from 'zod';
import {
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
  type CapabilityHandlerContext,
  type CapabilityInvocationContext,
} from '../../core/capabilities/index.js';
import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';
import { isServerPrincipal } from '../../connectors/principal/server-principal.js';
import {
  CLAIM_KEY_MAX_LENGTH,
  CLAIM_NOTE_MAX_LENGTH,
  normaliseClaimKey,
  type WorkClaim,
  type WorkClaimService,
} from './work-claim-service.js';

/** How a claim's holder is named to the chat asking. */
export interface ClaimHolderChat {
  /** The chat's title, or `null` when it has none or is private to the caller. */
  title: string | null;
  /** A markdown link to the chat, or `null` when it is private to the caller. */
  link: string | null;
  /** Whether the caller may not read this chat, so it is named only as private. */
  private: boolean;
}

declare module '../../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Work claims shared by one agent's chats (DOR-4019). */
    workClaimDeps?: {
      service: Pick<WorkClaimService, 'claim' | 'check' | 'release'>;
      agentIdForPath(agentPath: string): string | undefined;
      describeChat(
        caller: { sessionId: string; agentPath: string },
        sessionId: string
      ): Promise<ClaimHolderChat>;
    };
  }
}

const HolderSchema = z.object({
  /** `null` for a private holder's claim the caller did not name: the key is private text too. */
  key: z.string().nullable(),
  chat: z.object({
    sessionId: z.string().nullable(),
    title: z.string().nullable(),
    link: z.string().nullable(),
    private: z.boolean(),
    you: z.boolean(),
  }),
  note: z.string().nullable(),
  claimedAt: z.string(),
  lastSeenAt: z.string(),
});
const RefusalSchema = z.object({
  ok: z.literal(false),
  code: z.string(),
  error: z.string(),
  holder: HolderSchema.optional(),
});
const KeyInput = z
  .string()
  .min(1)
  .max(CLAIM_KEY_MAX_LENGTH)
  .describe('What you are working on: a ticket id, "PR #42", a branch or any short name.');

function requireDeps(deps: CapabilityDeps) {
  if (!deps.workClaimDeps) throw new Error('Work claims are unavailable.');
  return deps.workClaimDeps;
}

/** The chat and agent behind this call, from server-bound state only. */
function callerOf(
  deps: CapabilityDeps,
  context: CapabilityInvocationContext | CapabilityHandlerContext
) {
  const claims = requireDeps(deps);
  const identity = context.identity;
  if (!identity || identity.inactive)
    throw new CapabilityToolError({ code: 'NO_AGENT', error: 'This chat needs an active agent.' });
  const principal = context.serverPrincipal;
  const sessionId =
    principal && isServerPrincipal(principal) && principal.claims.kind === 'runtime'
      ? principal.claims.canonicalSessionId
      : context.sessionId;
  if (!sessionId)
    throw new CapabilityToolError({ code: 'NO_CHAT', error: 'Only a chat can claim work.' });
  const agentId = claims.agentIdForPath(identity.agentPath);
  if (!agentId)
    throw new CapabilityToolError({
      code: 'UNKNOWN_AGENT',
      error: 'This agent is not registered.',
    });
  return { claims, agentId, caller: { sessionId, agentPath: identity.agentPath } };
}

function keyOf(raw: string): string {
  const key = normaliseClaimKey(raw);
  if (!key) throw new CapabilityToolError({ code: 'INVALID_KEY', error: 'That key is empty.' });
  return key;
}

/**
 * How one claim reads to the calling chat. A holder it may not read is named only as private,
 * and its key is withheld too unless the caller named that key itself (DOR-4019 Security Must 1):
 * a key like "Offer letter for Sam" is as private as the chat that wrote it.
 */
async function describe(
  claims: ReturnType<typeof requireDeps>,
  caller: { sessionId: string; agentPath: string },
  claim: WorkClaim,
  named: boolean
): Promise<z.infer<typeof HolderSchema>> {
  const you = claim.sessionId === caller.sessionId;
  const chat = you
    ? { title: null, link: null, private: false }
    : await claims.describeChat(caller, claim.sessionId);
  return {
    key: chat.private && !named ? null : claim.key,
    chat: { sessionId: chat.private ? null : claim.sessionId, ...chat, you },
    note: chat.private ? null : claim.note,
    claimedAt: claim.claimedAt,
    lastSeenAt: claim.lastSeenAt,
  };
}

function heldBy(holder: z.infer<typeof HolderSchema>): string {
  const who = holder.chat.private
    ? 'a private chat of yours'
    : (holder.chat.link ?? holder.chat.title ?? 'another chat of yours');
  return `${holder.key ?? 'That work'} is already claimed by ${who} since ${holder.claimedAt}. Leave it, or ask that chat to release it.`;
}

// In-session only: a claim belongs to a chat, and the external server has none. Codex and
// OpenCode turns reach these through the runtime listener, which serves the in-session set.
const mcp = (toolName: string, idempotentHint = false) => ({
  mcp: {
    toolName,
    servers: ['in-session'] as 'in-session'[],
    annotations: { idempotentHint },
  },
});

/** Claim, check and release work across one agent's own chats. */
export const workClaimDomain: CapabilityDomain = {
  name: 'work-claims',
  assertDeps: requireDeps,
  capabilities: [
    defineCapability({
      id: 'work-claims.claim',
      title: 'Claim work',
      tier: 'act',
      area: null,
      areaNote: 'a claim is advisory and only ever your own agent’s',
      description:
        'Claim a piece of work by key (a ticket id, a PR, a branch) before you start it, so your other chats see it is taken. A key another live chat of yours holds is refused, naming that chat. Claiming a key you hold renews it. Claims end when you release them, or after two hours without your chat working. Advisory: it never blocks a person.',
      input: z.object({
        key: KeyInput,
        note: z
          .string()
          .max(CLAIM_NOTE_MAX_LENGTH)
          .optional()
          .describe('What you are doing, shown to your other chats.'),
      }),
      output: z.union([
        z.object({ ok: z.literal(true), renewed: z.boolean(), claim: HolderSchema }),
        RefusalSchema,
      ]),
      surfaces: mcp('work_claim', true),
      invoke: async (deps, input, context) => {
        const { claims, agentId, caller } = callerOf(deps, context);
        const result = claims.service.claim(
          agentId,
          caller.sessionId,
          keyOf(input.key),
          input.note
        );
        if (result.ok)
          return {
            ok: true as const,
            renewed: result.renewed,
            claim: await describe(claims, caller, result.claim, true),
          };
        const holder = await describe(claims, caller, result.holder, true);
        return { ok: false as const, code: result.code, error: heldBy(holder), holder };
      },
    }),
    defineCapability({
      id: 'work-claims.check',
      title: 'Check claimed work',
      tier: 'observe',
      area: null,
      areaNote: 'reading your own agent’s claims is always available',
      description:
        'List the work your chats have claimed, or only the keys you name. Check before you start a job another chat of yours may already have.',
      input: z.object({
        keys: z.array(KeyInput).max(50).optional().describe('Only these keys. Absent means all.'),
      }),
      output: z.object({ ok: z.literal(true), claims: z.array(HolderSchema) }),
      surfaces: mcp('work_claim_check', true),
      invoke: async (deps, input, context) => {
        const { claims, agentId, caller } = callerOf(deps, context);
        const keys = input.keys?.map(keyOf);
        const live = claims.service.check(agentId, keys);
        return {
          ok: true as const,
          claims: await Promise.all(
            live.map((claim) => describe(claims, caller, claim, keys !== undefined))
          ),
        };
      },
    }),
    defineCapability({
      id: 'work-claims.release',
      title: 'Release claimed work',
      tier: 'act',
      area: null,
      areaNote: 'only the chat that holds a claim can release it',
      description:
        'Release a key this chat claimed, when the work is done or you hand it on. Only the chat that holds a claim can release it.',
      input: z.object({ key: KeyInput }),
      output: z.union([z.object({ ok: z.literal(true) }), RefusalSchema]),
      surfaces: mcp('work_claim_release', true),
      invoke: async (deps, input, context) => {
        const { claims, agentId, caller } = callerOf(deps, context);
        const key = keyOf(input.key);
        const result = claims.service.release(agentId, caller.sessionId, key);
        if (result.ok) return { ok: true as const };
        if (result.code === 'NOT_CLAIMED')
          return { ok: false as const, code: result.code, error: `Nothing holds ${key}.` };
        const holder = await describe(claims, caller, result.holder!, true);
        return {
          ok: false as const,
          code: result.code,
          error: `Only the chat that holds ${key} can release it.`,
          holder,
        };
      },
    }),
  ],
};
