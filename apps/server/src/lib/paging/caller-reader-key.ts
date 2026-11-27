/**
 * The key a capability caller's sealed page cursors are bound to
 * (`sealed-cursor.ts`), for a list whose rows read differently for an agent
 * than for the person (DOR-4982): the marketplace installs and held-back
 * packages, the agent roster. A cursor sealed for one reader does not open for
 * another.
 *
 * @module lib/paging/caller-reader-key
 */

/** What a capability call says about who is asking. */
export interface PageCaller {
  /** The agent behind the call, when its token resolved. */
  readonly identity?: { readonly agentPath: string } | undefined;
  /** Whether a machine presented an agent token at all, resolved or not. */
  readonly agentIdentityPresented?: boolean | undefined;
  /** The signed-in person, when the surface verified one. */
  readonly userId?: string | undefined;
}

/**
 * The reader's key: the person (by sign-in when there is one), or the agent
 * asking. A machine that presented an agent token that did not resolve is one
 * reader of its own, never the person.
 *
 * @param caller - The call's context.
 */
export function callerReaderKey(caller: PageCaller): string {
  if (caller.identity) return `agent:${caller.identity.agentPath}`;
  if (caller.agentIdentityPresented === true) return 'agent:unresolved';
  return `person:${caller.userId ?? 'owner'}`;
}
