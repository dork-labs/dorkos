/**
 * "Ask the owner" (DOR-2956, `specs/everything-is-a-space` C7): the one way a teammate's turn
 * gets past the teammate tier, one tool call at a time, with the owner's yes.
 *
 * ## The flow
 *
 * 1. The turn calls `ask_owner { tool, input, why }`. The request is refused here when the tool
 *    is not one that can be asked for ({@link ASK_OWNER_TOOLS}); the rest (who asked, the
 *    limits, the card) is the port's, wired at startup (`communities/remote/wake/ask-owner-
 *    wiring.ts`).
 * 2. The owner gets an ordinary approval card that shows the tool, its full input, who asked and
 *    where the result will be read. The asking turn says "I've asked my owner." and ends.
 * 3. On Allow, a fresh teammate turn starts in the same room, carrying a one-call pass
 *    (`MessageOpts.roomTurn.teammatePass`). Its tier hook lets exactly one call through: the
 *    same tool with the same canonical input ({@link askCallHash}), spending the approval
 *    through `ApprovalService.consume` at that moment ({@link spendTeammatePass}). Nothing else
 *    is lifted, and a second call finds the pass gone and the approval spent.
 * 4. On Deny or expiry the agent posts a fixed line, and no model runs.
 *
 * ## What can be asked for
 *
 * The runtime's own tools that act on this computer, Bash included. Never another MCP server's
 * tool: those are the owner's connected apps and tools, which stay out of a teammate's reach
 * even with a card until cross-computer power is settled (A7). Never a DorkOS tool either: each
 * carries its own authorization, which is the agent's, not the teammate's. Never a helper agent
 * (one call that would make many) and never "always".
 *
 * @module services/core/turn-power/ask-owner
 */
import { hashApprovalInput } from '../approvals/approval-input-hash.js';

/**
 * The tools a teammate's turn may ask the owner for, by the runtime's own names. A list of what
 * may be asked for, not of what is dangerous: a tool nobody decided about cannot be asked for.
 */
export const ASK_OWNER_TOOLS: ReadonlySet<string> = new Set([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
]);

/** Input fields a tool reads only as a label, left out of what is compared. */
const LABEL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // Bash's `description` is what the CLI shows beside the command; it runs nothing, and the
  // model rewrites it each time, so the same command asked for twice would never match.
  Bash: ['description'],
};

/**
 * The zero-width space `prompt-defuse.ts` puts before every `@` in words that reach a model. It
 * is the one invisible character taken OUT of a call rather than refused: a model that copies
 * an argument from defused words hands it back, and what is shown and run is then the plain
 * text. Every other invisible character is refused ({@link hiddenCharacterRefusal}).
 */
const ZERO_WIDTH_SPACE = /\u200B/gu;

/**
 * Format characters (Unicode `Cf`): zero-width joiners and marks, the bidi embeddings, overrides
 * and isolates, the word joiner, the byte-order mark. Each can make a command read differently
 * from how it runs, so a call carrying one is never put to the owner.
 */
const FORMAT_CHARACTER = /\p{Cf}/u;

/**
 * One call as it is compared: zero-width spaces taken out of every string (a defused prompt can
 * hand them back in a copied argument), and label-only fields dropped.
 *
 * @param tool - The runtime's tool name.
 * @param input - The call's input.
 */
export function canonicalAskCall(
  tool: string,
  input: Record<string, unknown>
): { tool: string; input: Record<string, unknown> } {
  const labels = LABEL_FIELDS[tool] ?? [];
  const kept = Object.fromEntries(Object.entries(input).filter(([key]) => !labels.includes(key)));
  return { tool, input: stripZeroWidth(kept) as Record<string, unknown> };
}

/** A value with every zero-width space removed from every string in it. */
function stripZeroWidth(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(ZERO_WIDTH_SPACE, '');
  if (Array.isArray(value)) return value.map(stripZeroWidth);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, stripZeroWidth(inner)])
    );
  }
  return value;
}

/**
 * The hash an approval for this call is bound to: over the canonical `{ tool, input }`.
 *
 * @param tool - The runtime's tool name.
 * @param input - The call's input.
 * @throws {Error} When the input cannot be hashed (a function, a cycle).
 */
export function askCallHash(tool: string, input: Record<string, unknown>): string {
  return hashApprovalInput(canonicalAskCall(tool, input));
}

/**
 * Why a call cannot be shown to the owner exactly, or `null` when it can: any key or string in
 * its canonical input that holds an invisible or direction-changing character.
 *
 * @param tool - The runtime's tool name.
 * @param input - The call's input.
 */
export function hiddenCharacterRefusal(
  tool: string,
  input: Record<string, unknown>
): string | null {
  const hidden = (value: unknown): boolean => {
    if (typeof value === 'string') return FORMAT_CHARACTER.test(value);
    if (Array.isArray(value)) return value.some(hidden);
    if (value !== null && typeof value === 'object') {
      return Object.entries(value).some(([key, inner]) => hidden(key) || hidden(inner));
    }
    return false;
  };
  return hidden(canonicalAskCall(tool, input).input)
    ? 'That input has hidden or direction-changing characters, so the owner couldn’t see exactly what would run. Ask again without them.'
    : null;
}

/**
 * Why a tool cannot be asked for at all, or `null` when it can.
 *
 * @param tool - The tool name the turn gave.
 */
export function askableRefusal(tool: string): string | null {
  if (tool.startsWith('mcp__')) {
    return 'Connected apps and other tools can’t be asked for from a space. Only this computer’s own tools, like Bash, Read or Edit.';
  }
  if (!ASK_OWNER_TOOLS.has(tool)) {
    return `"${tool}" can’t be asked for. Ask for one of: ${[...ASK_OWNER_TOOLS].join(', ')}.`;
  }
  return null;
}

/** Who is asking, and from where: the teammate turn's own scope. */
export interface AskOwnerScope {
  /** The local room the turn answers. */
  roomId: string;
  /** The agent, by its author id in that room. */
  authorId: string;
  /** The teammate whose message the turn answers. */
  asker: { memberId: string; displayName: string };
  /** The session the turn runs on, for the room's per-turn post count. */
  sessionId?: string;
}

/** What the turn asked for. */
export interface AskOwnerRequest {
  /** The runtime's tool name. */
  tool: string;
  /** The exact input. */
  input: Record<string, unknown>;
  /** Why the teammate needs it, in a sentence. */
  why: string;
}

/** The answer the tool hands the model: asked, or refused with the reason to pass on. */
export type AskOwnerResult = { ok: true; message: string } | { ok: false; message: string };

/** The pass a turn carries, and the scope it may be spent in. */
export interface PassSpend {
  /** The approval the pass spends. */
  approvalId: string;
  /** The canonical hash of the call being made. */
  inputHash: string;
  /** The room the turn answers. */
  roomId: string;
  /** The agent's author id in it. */
  authorId: string;
  /** The teammate the turn answers. */
  memberId: string | undefined;
}

/** What the rest of the server does for "ask the owner": set once at startup. */
export interface AskOwnerPort {
  /** Record the request, raise the card, tell the room; or say why not. */
  request(scope: AskOwnerScope, request: AskOwnerRequest): Promise<AskOwnerResult>;
  /** Spend one pass on one call; true only when the approval was granted and this spent it. */
  spend(spend: PassSpend): boolean;
}

let port: AskOwnerPort | undefined;

/**
 * Connect "ask the owner" to the approvals store and the rooms. Until this runs, every request
 * is refused and no pass is ever spent.
 *
 * @param next - The port, or `undefined` to disconnect (tests).
 */
export function setAskOwnerPort(next: AskOwnerPort | undefined): void {
  port = next;
}

/**
 * Ask the owner for one call on a teammate's behalf.
 *
 * @param scope - The teammate turn's room, agent and asker.
 * @param request - The call and the reason.
 */
export async function askOwner(
  scope: AskOwnerScope,
  request: AskOwnerRequest
): Promise<AskOwnerResult> {
  const refused =
    askableRefusal(request.tool) ?? hiddenCharacterRefusal(request.tool, request.input);
  if (refused) return { ok: false, message: refused };
  if (!port) return { ok: false, message: 'Asking the owner isn’t available on this computer.' };
  return port.request(scope, request);
}

/**
 * Spend a turn's pass on this call, when it is the call the owner allowed. Never throws: a
 * failure is a refusal.
 *
 * @param spend - The pass, the call's hash and the scope it is made in.
 */
export function spendTeammatePass(spend: PassSpend): boolean {
  try {
    return port?.spend(spend) === true;
  } catch {
    return false;
  }
}
