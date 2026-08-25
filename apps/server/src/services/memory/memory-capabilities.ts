/**
 * The `memory_write` capability: how an agent saves something it wants to keep.
 *
 * One verb, three actions, and no path argument anywhere — which is the whole
 * security design and the reason this file is short. The file an agent writes
 * to is derived from WHO IS CALLING, never from what it asks for, so there is
 * nothing to abuse: the provider resolves `<agentPath>/.dork/MEMORY.md` from the
 * identity the session presented, and an agent that presents none is refused
 * rather than defaulted somewhere.
 *
 * @module server/services/memory/memory-capabilities
 */
import { z } from 'zod';
import { MEMORY_MAX_CHARS } from '@dorkos/shared/convention-files';
import {
  MemoryCapExceededError,
  MemoryIOError,
  MemoryMatchError,
  MemoryNoteShapeError,
} from '@dorkos/shared/memory-provider';
import { defineCapability, type CapabilityDeps } from '../core/capabilities/index.js';
import type { CapabilityDomain } from '../core/capabilities/index.js';
import type { CapabilityHandlerContext } from '../core/capabilities/registry.js';
import { getMemoryProvider } from './index.js';

declare module '../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /**
     * How a note learns which room it was written in, for the provenance suffix.
     *
     * Optional because rooms can be switched off, and a note written with rooms
     * off is honestly a note from a direct chat. Never a way to CHOOSE a room:
     * it answers for the session that is calling, and the session id is not
     * something the model supplies.
     */
    memoryDeps?: {
      /**
       * The room label to record for a session, or `null` when the session is
       * not answering for a room.
       *
       * @param sessionId - The calling session.
       */
      roomLabelForSession(sessionId: string): string | null;
    };
  }
}

/**
 * The refusal a session with no agent identity gets.
 *
 * A plain sentence, not a stack trace and not a code: a bare-folder session has
 * no memory file because it is not an agent, and that is a fact about the
 * situation rather than an error somebody can fix by retrying. Naming the
 * condition ("this session is not running as an agent") is what stops a model
 * trying three more spellings of the same call.
 */
export const MEMORY_NO_AGENT_MESSAGE =
  'This session is not running as one of your agents, so it has no memory file to write to. ' +
  'Memory belongs to an agent, and this session is a plain working directory. Nothing was saved.';

/** The typed refusal shape every failed write comes back as. */
const MemoryWriteOutcomeSchema = z.object({
  saved: z.boolean(),
  /** Present when `saved` — how big the file is now, against its limit. */
  chars: z.number().int().min(0).optional(),
  limit: z.number().int().min(0).optional(),
  /** Present when the file was created by this write. */
  created: z.boolean().optional(),
  /** Present when `saved` is false. Plain language, addressed to the caller. */
  error: z.string().optional(),
  /** Which kind of refusal, so a caller can tell a fixable one from a fact. */
  code: z
    .enum(['no-agent', 'not-found', 'ambiguous', 'protected-header', 'multi-line', 'too-big', 'io'])
    .optional(),
  /** Lines that came closest, when a `replace` or `remove` named no single note. */
  nearMatches: z.array(z.string()).optional(),
});

/** Today, as the date a note records. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Where this turn is happening, as the note will record it.
 *
 * **Derived here, from the turn's own context, and never from the model.** The
 * whole value of provenance is that a poisoned entry names the room that
 * poisoned it — which only holds if the writer cannot choose what it says. There
 * is no parameter for this, and a string inside `text` that looks like a suffix
 * does not replace the one this function produces, because this one is appended
 * afterwards by the engine.
 *
 * @param deps - The capability bag; `memoryDeps` answers for rooms when wired.
 * @param context - The invocation, which carries the calling session's id.
 */
function provenanceFor(
  deps: CapabilityDeps,
  context: CapabilityHandlerContext
): { room: string | null; date: string } {
  const sessionId = context.sessionId;
  const room = sessionId ? (deps.memoryDeps?.roomLabelForSession(sessionId) ?? null) : null;
  return { room, date: today() };
}

/**
 * Turn a refusal from the engine into something a caller can act on.
 *
 * Every branch is a REFUSAL, never a partial write — the engine checks the cap
 * and the match before it writes anything — so "nothing was saved" is true in
 * all of them and each says so.
 *
 * @param err - Whatever the write threw.
 */
function refusal(err: unknown): z.infer<typeof MemoryWriteOutcomeSchema> {
  if (err instanceof MemoryMatchError) {
    return { saved: false, error: err.message, code: err.kind, nearMatches: err.nearMatches };
  }
  if (err instanceof MemoryNoteShapeError) {
    return { saved: false, error: err.message, code: 'multi-line' };
  }
  if (err instanceof MemoryCapExceededError) {
    return { saved: false, error: err.message, code: 'too-big', limit: err.maxChars };
  }
  if (err instanceof MemoryIOError) {
    return { saved: false, error: err.message, code: 'io' };
  }
  // Anything else is unexpected, and the turn still must not die over a notes
  // file. The message is the engine's own, which is written for a reader.
  return {
    saved: false,
    error: err instanceof Error ? err.message : 'Your memory file could not be saved.',
    code: 'io',
  };
}

/**
 * The memory domain: one capability, always available.
 *
 * Unlike rooms or the marketplace there is no handle to switch off — every
 * install has a filesystem, and the builtin provider needs nothing else. So this
 * domain is composed unconditionally and `assertDeps` has nothing to assert.
 */
export const memoryDomain: CapabilityDomain = {
  name: 'memory',
  assertDeps: () => undefined,
  capabilities: [
    defineCapability({
      id: 'memory.write',
      title: 'Save something to your memory',
      description:
        'Save a durable fact, preference or lesson to your own memory file, so your other ' +
        'sessions know it too — you are one session of yourself, and sessions share this file ' +
        'but not conversations. Use `add` for something new, `replace` to correct a note, and ' +
        '`remove` to forget one. `replace` and `remove` find the note by quoting a unique piece ' +
        'of it; there are no line numbers, and text that matches twice or not at all is refused ' +
        'with the closest lines so you can quote better. Every note records where you learned ' +
        'it automatically — you do not write that part and cannot change it. Your memory is ' +
        'small on purpose, and it can come up in ANY conversation you join, including channels ' +
        'with other people in them, so never save secrets or anything you would not say out loud ' +
        'in a shared room.',
      tier: 'act',
      input: z.object({
        action: z
          .enum(['add', 'replace', 'remove'])
          .describe('add a new note, replace an existing one, or remove one.'),
        text: z
          .string()
          .min(1)
          .max(2000)
          .optional()
          .describe(
            'The note, for `add` and `replace`. ONE thing worth keeping, on one line, in your ' +
              'words — a line break is refused, so call again for the next note.'
          ),
        old_text: z
          .string()
          .min(1)
          .optional()
          .describe(
            'For `replace` and `remove`: a piece of the existing note, quoted exactly, that ' +
              'appears only once in your memory.'
          ),
      }),
      output: MemoryWriteOutcomeSchema,
      surfaces: {
        mcp: {
          toolName: 'memory_write',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: false },
        },
      },
      invoke: async (deps, input, context) => {
        // **The path jail, and it is one line because there is nothing to jail.**
        // The target is resolved from the identity this session presented, so a
        // caller cannot name a file, a directory, or another agent. A session
        // with no identity has no memory file, which is the correct boundary
        // rather than a gap: the answer is a refusal, not a default location.
        const identity = context.identity;
        if (!identity) {
          return { saved: false, error: MEMORY_NO_AGENT_MESSAGE, code: 'no-agent' as const };
        }

        if ((input.action === 'add' || input.action === 'replace') && input.text === undefined) {
          return {
            saved: false,
            error: `\`${input.action}\` needs the note itself — pass \`text\`. Nothing was saved.`,
            code: 'not-found' as const,
          };
        }
        if (
          (input.action === 'replace' || input.action === 'remove') &&
          input.old_text === undefined
        ) {
          return {
            saved: false,
            error:
              `\`${input.action}\` needs to know which note you mean — pass \`old_text\`, ` +
              `quoting a piece of it that appears only once. Nothing was saved.`,
            code: 'not-found' as const,
          };
        }

        // `agentPath` IS the agent's identity in this product (ADR-0043), so it
        // serves as both halves of the ref. The provider resolves the file from
        // the path; the id is what a log line names.
        const ref = { agentId: identity.agentPath, agentPath: identity.agentPath };
        try {
          const result = await getMemoryProvider().write(
            ref,
            input.action === 'add'
              ? { action: 'add', text: input.text!, provenance: provenanceFor(deps, context) }
              : input.action === 'replace'
                ? { action: 'replace', oldText: input.old_text!, text: input.text! }
                : { action: 'remove', oldText: input.old_text! }
          );
          return {
            saved: true,
            chars: result.chars,
            limit: MEMORY_MAX_CHARS,
            created: result.created,
          };
        } catch (err) {
          return refusal(err);
        }
      },
    }),
  ],
};
