/**
 * The `MemoryProvider` port — one contract for an agent's durable memory: the
 * builtin `MEMORY.md` file today, a vector store or a hosted memory service
 * later.
 *
 * It is built by the same four-rule recipe as
 * {@link ./community-adapter.js | CommunityAdapter}, restated here because each
 * rule means something specific about memory (spec `agent-memory`, D1 + D7):
 *
 * 1. **One instance serves ONE memory backend.** Every address on this port is
 *    the pair `(provider, {@link AgentMemoryRef})`.
 * 2. **Every method is REQUIRED.** A capability-gated method whose capability is
 *    off rejects with {@link MemoryUnsupportedError} — never a silent no-op,
 *    never a partial write. Optional methods let a backend omit a surface with
 *    the compiler silent; the builtin provider declares `search: false` and
 *    refuses {@link MemoryProvider.query} loudly rather than answering "nothing
 *    found", which is the same sentence a working search returns for a fact the
 *    agent really did record.
 * 3. **No credential crosses this port** — not as an argument, not on a DTO, not
 *    in `info.capabilities`. A provider resolves its own from a server-side
 *    store.
 * 4. **Nothing here executes an agent.** No turn, no session handle, no
 *    invocation. Memory is read and written *around* a turn, never by one.
 *
 * **Scope is the agent identity, never a session or a room.** That is the whole
 * point of the feature: an agent in three channels, two DMs and one direct chat
 * is six runtime transcripts and one memory file. {@link AgentMemoryRef} carries
 * no session id and no room id, so a provider cannot accidentally shard memory
 * per conversation.
 *
 * **Reads are three-way honest, and one phrasing is banned outright.** A
 * snapshot reports `'present'`, `'absent'` or `'error'`
 * ({@link MemorySnapshotSchema}), and no consumer of this port may render "you
 * have no memory yet" or any equivalent — an I/O error must never invite an
 * agent to start a fresh file over the top of real notes it could not read.
 *
 * Schemas are the authoritative contract (the repo is Zod-first, on v4 with
 * `@dorkos/shared`); TS types derive via `z.infer`. The port itself is a runtime
 * port rather than a serializable DTO, so it is a TS interface over the derived
 * types.
 *
 * See `specs/agent-memory/02-specification.md` §D7. The conformance suite
 * (`memoryConformance`), the `fake-memory-provider` and the `memory.provider`
 * config key land in Phase 3; until then `builtin` (`@dorkos/memory`) is the
 * only registered provider.
 *
 * @module shared/memory-provider
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 1. Addressing
// ---------------------------------------------------------------------------

/**
 * The one address this port understands: an agent's identity plus the directory
 * that identity owns.
 *
 * Both fields are here because neither alone is sufficient. `agentId` is what a
 * remote backend keys on and what a log line should name; `agentPath` is what
 * the builtin file store jails its writes inside. A backend uses the one it
 * needs and ignores the other — that is cheaper than two ref shapes, and it
 * keeps a provider swap from rippling into every call site.
 *
 * `agentPath` is validated as non-empty here and as an **absolute path with no
 * `..` segment** by the filesystem-backed provider, which is where a traversal
 * could actually do harm. This schema deliberately does not encode that: a
 * remote provider has no filesystem and would be rejecting a value it never
 * touches.
 */
export const AgentMemoryRefSchema = z.object({
  /** The agent's opaque local id — what a backend keys on, and what a log names. */
  agentId: z.string().min(1),
  /** The agent's own directory. The builtin store jails every write inside it. */
  agentPath: z.string().min(1),
});
/** One agent's memory, addressed. See {@link AgentMemoryRefSchema}. */
export type AgentMemoryRef = z.infer<typeof AgentMemoryRefSchema>;

// ---------------------------------------------------------------------------
// 2. Capabilities
// ---------------------------------------------------------------------------

/**
 * What a memory backend can do beyond the universal read/write surface.
 *
 * Only two flags exist, and each gates exactly one method. Reading a snapshot,
 * writing an entry and forgetting one are universal: a backend that cannot do
 * all three is not a memory backend, so none of them has a flag. **Nothing here
 * is descriptive colour** — no display name, no storage kind, no version — for
 * the same reason `CommunityCapabilities` admits none: a flag nobody branches on
 * is a claim nothing can check.
 */
export const MemoryCapabilitiesSchema = z.object({
  /**
   * Can this backend answer {@link MemoryProvider.query} — "what do I know about
   * X" — rather than only returning the whole file?
   *
   * The builtin provider declares `false`. Its whole memory fits in one capped
   * snapshot that is already in the prompt, so a search over it would answer a
   * question the reader can answer by looking.
   */
  search: z.boolean(),
  /**
   * Can this backend rewrite its own memory into a shorter equivalent when it
   * approaches the cap ({@link MemoryProvider.consolidate})?
   *
   * The builtin provider declares `false` in v1: consolidation there is the
   * agent's own job, instructed by the cap refusal
   * ({@link MemoryCapExceededError}), not a background rewrite of a file the
   * operator can open in an editor.
   */
  consolidate: z.boolean(),
});
/** What a memory backend can do beyond read/write. See {@link MemoryCapabilitiesSchema}. */
export type MemoryCapabilities = z.infer<typeof MemoryCapabilitiesSchema>;

/**
 * Every capability that GATES A METHOD, in the order a conformance suite would
 * iterate them.
 *
 * The list is the mechanism behind "every off capability refuses": Phase 3's
 * `memoryConformance` builds a `Record<MemoryGatedCapability, …>` of probes, so
 * adding a member here fails the suite's own typecheck until its refusal is
 * asserted. Every member of {@link MemoryCapabilitiesSchema} is on this list
 * today, and that is a property of having minted no descriptive flags rather
 * than a coincidence.
 */
export const MEMORY_GATED_CAPABILITIES = ['search', 'consolidate'] as const;
/** One capability that gates a method. See {@link MEMORY_GATED_CAPABILITIES}. */
export type MemoryGatedCapability = (typeof MEMORY_GATED_CAPABILITIES)[number];

/** How a provider identifies itself and what it can do. */
export const MemoryProviderInfoSchema = z.object({
  /** Stable provider id, e.g. `'builtin'`. The value the `memory.provider` config key names. */
  id: z.string().min(1),
  /** What this backend can do beyond the universal surface. */
  capabilities: MemoryCapabilitiesSchema,
});
/** A provider's identity and capabilities. See {@link MemoryProviderInfoSchema}. */
export type MemoryProviderInfo = z.infer<typeof MemoryProviderInfoSchema>;

// ---------------------------------------------------------------------------
// 3. Reading
// ---------------------------------------------------------------------------

/**
 * What one agent's memory looks like right now.
 *
 * **`status` is the load-bearing field and it has three values, not two.** A
 * file that is confirmed absent and a file that could not be read are different
 * situations with different correct behaviours: the first is a brand-new agent,
 * the second is a problem somebody should see in a log. Collapsing them lets an
 * unreadable file present as an empty one, and an agent told its memory is empty
 * writes a fresh note over the top of everything it could not read. A caller
 * MUST branch on `status` and MUST NOT infer "no memory" from an empty
 * `content`.
 *
 * For the same reason there is no field, and no rendering built from these
 * fields, that says "you have no memory yet". Absence renders as **nothing at
 * all**.
 *
 * `bytes` is the size of the stored memory itself, **not** of `content`. The two
 * differ exactly when `truncated` is true, and that difference is the point: a
 * consumer can say "this file is bigger than what you are seeing" because it was
 * told both numbers.
 */
export const MemorySnapshotSchema = z
  .object({
    /**
     * - `'present'` — memory exists and `content` is it (possibly truncated).
     * - `'absent'` — the backend confirmed there is nothing stored. Not an error.
     * - `'error'` — the backend could not tell. `error` says why, for a log.
     */
    status: z.enum(['present', 'absent', 'error']),
    /** The memory, ready to render. Empty string on `'absent'` and `'error'`. */
    content: z.string(),
    /** Size of the STORED memory in UTF-8 bytes — larger than `content` when `truncated`. */
    bytes: z.number().int().min(0),
    /** Whether `content` is a prefix of the stored memory rather than all of it. */
    truncated: z.boolean(),
    /**
     * A plain-language line a consumer must render **visibly** beside the
     * content, e.g. "This file is bigger than the limit, so only the first part
     * is shown here." Required whenever `truncated` — a silent trim is the
     * failure this field exists to prevent.
     */
    warning: z.string().min(1).optional(),
    /**
     * Why the read failed. Present iff `status === 'error'`. For the server log;
     * never rendered into a prompt, because a raw I/O message is neither useful
     * to a model nor safe to hand it.
     */
    error: z.string().min(1).optional(),
  })
  .superRefine((snapshot, ctx) => {
    // Each of these is a state that would silently misreport memory, so the
    // schema refuses to construct it rather than trusting every provider to
    // remember the rule.
    if (snapshot.status === 'error') {
      if (!snapshot.error) {
        ctx.addIssue({
          code: 'custom',
          path: ['error'],
          message: "an 'error' snapshot must say what went wrong",
        });
      }
      if (snapshot.content !== '') {
        ctx.addIssue({
          code: 'custom',
          path: ['content'],
          message: "an 'error' snapshot must carry no content — a partial read is not memory",
        });
      }
    }
    if (snapshot.status === 'absent') {
      if (snapshot.content !== '' || snapshot.bytes !== 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['content'],
          message: "an 'absent' snapshot must be empty",
        });
      }
      if (snapshot.error) {
        ctx.addIssue({
          code: 'custom',
          path: ['error'],
          message: "an 'absent' snapshot is not a failure — use status 'error' instead",
        });
      }
    }
    if (snapshot.status !== 'error' && snapshot.error) {
      ctx.addIssue({
        code: 'custom',
        path: ['error'],
        message: "only an 'error' snapshot may carry an error",
      });
    }
    if (snapshot.truncated && !snapshot.warning) {
      ctx.addIssue({
        code: 'custom',
        path: ['warning'],
        message: 'a truncated snapshot must carry a visible warning',
      });
    }
  });
/** One agent's memory as it stands. See {@link MemorySnapshotSchema}. */
export type MemorySnapshot = z.infer<typeof MemorySnapshotSchema>;

// ---------------------------------------------------------------------------
// 4. Writing
// ---------------------------------------------------------------------------

/**
 * Where a note came from — **derived by the caller from the turn it happened
 * in, never supplied by the model.**
 *
 * The provenance suffix is one of the three defences around a memory file that
 * is writable during a room turn (the others are the fence around the injected
 * block and the adversarial eval): a poisoned note names the room that poisoned
 * it, the operator reading the file sees where each belief came from, and the
 * agent reading its own notes sees the same. That property survives only while
 * the model cannot choose the value, which is why this lives on the write op the
 * handler builds and not on the tool schema the model fills in.
 */
export const MemoryProvenanceSchema = z.object({
  /**
   * The room this was learned in, as a person would name it (`'#general'`), or
   * `null` for a one-to-one chat with no room.
   */
  room: z.string().min(1).nullable(),
  /** The day it was learned, `YYYY-MM-DD`. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a provenance date must be YYYY-MM-DD'),
});
/** Where a note came from. See {@link MemoryProvenanceSchema}. */
export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>;

/**
 * One change to an agent's memory.
 *
 * **`replace` and `remove` locate their target by unique substring, and there
 * are deliberately no line numbers.** A line number is a coordinate into a file
 * the operator may have edited between two turns, so an agent holding one from
 * earlier in the conversation would silently rewrite the wrong line. A quoted
 * substring either matches exactly once or the write is refused with
 * {@link MemoryMatchError} listing what was near — the same discipline the file
 * edit tools use, for the same reason.
 */
export const MemoryWriteOpSchema = z.discriminatedUnion('action', [
  z.object({
    /** Append a new note. */
    action: z.literal('add'),
    /** What to remember, in the agent's own words. */
    text: z.string().min(1),
    /** Where it was learned. Omitted only by a caller with no turn context, e.g. a migration. */
    provenance: MemoryProvenanceSchema.optional(),
  }),
  z.object({
    /** Rewrite an existing note. */
    action: z.literal('replace'),
    /** Text that must appear EXACTLY ONCE in the current memory. */
    oldText: z.string().min(1),
    /** What replaces it. */
    text: z.string().min(1),
  }),
  z.object({
    /** Forget an existing note. */
    action: z.literal('remove'),
    /** Text that must appear EXACTLY ONCE in the current memory. */
    oldText: z.string().min(1),
  }),
]);
/** One change to an agent's memory. See {@link MemoryWriteOpSchema}. */
export type MemoryWriteOp = z.infer<typeof MemoryWriteOpSchema>;

/**
 * The receipt of a committed write.
 *
 * `chars` is reported rather than only `bytes` because the cap is expressed in
 * characters ({@link MemoryCapExceededError}), so this is the number a caller
 * needs to tell an agent how much room is left without measuring anything
 * itself.
 */
export const MemoryWriteResultSchema = z.object({
  /** Whether this write brought the agent's memory into existence. */
  created: z.boolean(),
  /** Size of the stored memory after the write, in characters — the unit the cap is in. */
  chars: z.number().int().min(0),
  /** Size of the stored memory after the write, in UTF-8 bytes. */
  bytes: z.number().int().min(0),
});
/** The receipt of a committed write. See {@link MemoryWriteResultSchema}. */
export type MemoryWriteResult = z.infer<typeof MemoryWriteResultSchema>;

// ---------------------------------------------------------------------------
// 5. Querying and forgetting
// ---------------------------------------------------------------------------

/** A lookup against an agent's memory. Gated on `search`. */
export const MemoryQuerySchema = z.object({
  /** What to look for, in natural language. A backend may match it however it likes. */
  text: z.string().min(1),
  /** How many hits the caller wants at most. A backend may return fewer. */
  limit: z.number().int().positive().optional(),
});
/** A lookup against an agent's memory. See {@link MemoryQuerySchema}. */
export type MemoryQuery = z.infer<typeof MemoryQuerySchema>;

/**
 * One remembered thing a query matched.
 *
 * `provenance` is the rendered suffix (`'(noted in #general, 2026-08-24)'`) or
 * `null` for a note that carries none — a hand-written line, or one migrated
 * from before provenance existed. It is a rendered string rather than a
 * {@link MemoryProvenance} because a backend that stores prose can only report
 * what the note says, and re-parsing it into fields would invent certainty it
 * does not have.
 */
export const MemoryHitSchema = z.object({
  /** The note. */
  text: z.string().min(1),
  /** The rendered provenance suffix, or `null` when the note carries none. */
  provenance: z.string().min(1).nullable(),
});
/** One remembered thing a query matched. See {@link MemoryHitSchema}. */
export type MemoryHit = z.infer<typeof MemoryHitSchema>;

/** What a query found. Deliberately a wrapper, so a backend can add degradation later without a breaking change. */
export const MemoryHitsSchema = z.object({
  /** The matches, best first. Empty when the backend genuinely found nothing. */
  hits: z.array(MemoryHitSchema),
});
/** What a query found. See {@link MemoryHitsSchema}. */
export type MemoryHits = z.infer<typeof MemoryHitsSchema>;

/**
 * What to forget.
 *
 * Same unique-substring rule as {@link MemoryWriteOpSchema}'s `remove`, and the
 * same {@link MemoryMatchError} when the text matches twice or not at all.
 * `forget` exists beside that op because forgetting is a distinct act a surface
 * may offer on its own — an operator deleting a note they disagree with — and a
 * backend may want to log or confirm it differently from an edit.
 */
export const MemorySelectorSchema = z.object({
  /** Text that must appear EXACTLY ONCE in the current memory. */
  text: z.string().min(1),
});
/** What to forget. See {@link MemorySelectorSchema}. */
export type MemorySelector = z.infer<typeof MemorySelectorSchema>;

// ---------------------------------------------------------------------------
// 6. Typed errors
// ---------------------------------------------------------------------------

/**
 * Rejected by any capability-gated method whose capability is off. Never a
 * silent no-op and never a partial write — a required method with a typed
 * refusal is what an optional method cannot be: visible to the compiler and
 * checkable by the conformance suite.
 *
 * The distinction matters most for `query`: "this backend cannot search" and
 * "this backend searched and found nothing" are the same sentence to a model
 * unless one of them is an error.
 */
export class MemoryUnsupportedError extends Error {
  /**
   * Build a refusal naming the capability that gated it and the method it gates.
   *
   * @param providerId - The provider that refused.
   * @param capability - The capability that gated the call, e.g. `'search'`.
   * @param method - The method that was called, e.g. `'query'`.
   * @param reason - What is actually wrong, when "the capability is off" would
   *   be untrue or unhelpful.
   */
  constructor(
    readonly providerId: string,
    readonly capability: MemoryGatedCapability,
    readonly method: string,
    readonly reason?: string
  ) {
    super(
      `'${method}' is not supported by memory provider '${providerId}': ${
        reason ?? `capability '${capability}' is off`
      }`
    );
    this.name = 'MemoryUnsupportedError';
  }
}

/**
 * Rejected when the text a write names does not identify exactly one place in
 * the agent's memory — it appears more than once, or not at all.
 *
 * **The refusal lists what was near**, because the alternative is an agent
 * retrying the same failing quote with a different guess each turn. The message
 * is plain language addressed to whoever reads it, model or person: this text
 * ends up in a tool result and, when the operator is watching, on screen.
 *
 * It is a port-level error rather than an engine-level one because the
 * unique-substring rule is part of what this port promises: any backend that
 * accepts `replace` or `remove` owes the same refusal, and a consumer must be
 * able to catch it without depending on whichever engine is installed.
 */
export class MemoryMatchError extends Error {
  /**
   * Build the refusal, naming the text that failed and what was near it.
   *
   * @param kind - `'ambiguous'` when the text matched more than once,
   *   `'not-found'` when it matched nothing.
   * @param needle - The text the caller named.
   * @param nearMatches - Lines from the current memory that came closest, for
   *   the caller to choose between or correct against. May be empty when
   *   nothing resembled it.
   */
  constructor(
    readonly kind: 'ambiguous' | 'not-found',
    readonly needle: string,
    readonly nearMatches: string[]
  ) {
    const lead =
      kind === 'ambiguous'
        ? `The text you named appears more than once in your memory, so it does not say which note you meant.`
        : `Nothing in your memory matches the text you named.`;
    const near =
      nearMatches.length > 0
        ? ` Closest lines:\n${nearMatches.map((line) => `- ${line}`).join('\n')}`
        : ' Nothing in the file came close.';
    super(`${lead} You asked for: "${needle}".${near}`);
    this.name = 'MemoryMatchError';
  }
}

/**
 * Rejected when a write would take an agent's memory past its cap.
 *
 * The message names all three things a caller needs to act: how big the memory
 * is now, what the limit is, and what to do about it — tidy up first, then save
 * again. An error that named only the limit would leave an agent guessing how
 * much to cut.
 */
export class MemoryCapExceededError extends Error {
  /**
   * Build the refusal, naming the current size, the attempted size, the cap and
   * the fix.
   *
   * @param currentChars - Size of the stored memory before this write.
   * @param attemptedChars - Size it would have been after this write.
   * @param maxChars - The cap.
   */
  constructor(
    readonly currentChars: number,
    readonly attemptedChars: number,
    readonly maxChars: number
  ) {
    super(
      `Your memory file is ${currentChars} characters and this change would make it ` +
        `${attemptedChars}. The limit is ${maxChars} characters. Tidy it up first — combine ` +
        `notes that say the same thing and delete the ones that no longer matter — then save ` +
        `this again.`
    );
    this.name = 'MemoryCapExceededError';
  }
}

// ---------------------------------------------------------------------------
// 7. The port
// ---------------------------------------------------------------------------

/**
 * Universal contract for an agent memory backend.
 *
 * Why each method earns its place: `getSnapshot` is the read every injection
 * path makes once per session; `write` is the single mutation, an op union
 * rather than three methods so a backend implements one transaction and a
 * caller adds an op kind without widening the port; `forget` is separated from
 * `write`'s `remove` because deleting is an act a surface may offer on its own;
 * `query` is what a backend with real search offers instead of handing back the
 * whole file; and `consolidate` is the one method that may take its time.
 *
 * Both gated methods reject with {@link MemoryUnsupportedError} when their
 * capability is off. Neither may quietly degrade to the universal surface — a
 * `query` that fell back to returning everything would report the whole file as
 * a match for every question.
 */
export interface MemoryProvider {
  /** Who this provider is and what it can do. Static for the life of the instance. */
  readonly info: MemoryProviderInfo;

  /**
   * Read one agent's memory. Three-way honest: present, confirmed absent, or a
   * read that failed. **Never throws for an absent or unreadable memory** — both
   * are reported on the result, because both are states an injection path must
   * render (as nothing) rather than states that should abort a turn.
   *
   * @param ref - Whose memory to read.
   */
  getSnapshot(ref: AgentMemoryRef): Promise<MemorySnapshot>;

  /**
   * Apply one change, atomically with respect to every other writer of the same
   * agent's memory in this process.
   *
   * Throws {@link MemoryMatchError} when a `replace` or `remove` does not name
   * exactly one place, and {@link MemoryCapExceededError} when the result would
   * exceed the backend's cap. Both are refusals, not partial writes: a failed
   * write leaves memory exactly as it was.
   *
   * @param ref - Whose memory to change.
   * @param op - The change.
   */
  write(ref: AgentMemoryRef, op: MemoryWriteOp): Promise<MemoryWriteResult>;

  /**
   * Look something up. Gated on `search`; otherwise rejects with
   * {@link MemoryUnsupportedError} rather than returning no hits.
   *
   * @param ref - Whose memory to search.
   * @param query - What to look for.
   */
  query(ref: AgentMemoryRef, query: MemoryQuery): Promise<MemoryHits>;

  /**
   * Forget one note, located by unique substring. Throws
   * {@link MemoryMatchError} on an ambiguous or absent selector — forgetting the
   * wrong note is worse than forgetting none.
   *
   * @param ref - Whose memory to change.
   * @param selector - Which note to forget.
   */
  forget(ref: AgentMemoryRef, selector: MemorySelector): Promise<void>;

  /**
   * Rewrite this agent's memory into a shorter equivalent. Gated on
   * `consolidate`; otherwise rejects with {@link MemoryUnsupportedError}.
   *
   * A caller MUST NOT block a turn on it: the whole point is that it may take
   * as long as a model call, and memory must never be able to hold up a
   * conversation.
   *
   * @param ref - Whose memory to consolidate.
   */
  consolidate(ref: AgentMemoryRef): Promise<void>;
}
