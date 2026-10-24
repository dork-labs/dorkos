/**
 * Which of a person's agents a request made with one installation's grant may act on. Shared by
 * enrolment, availability reports and an agent's direct-message switch.
 *
 * @module routes/community/agents/agent-scope
 */

/**
 * SQL that is true when a request made with the grant in `grantParam` may act on the agent row
 * aliased `alias`: the grant's own agent; a legacy one (NULL: enrolled before the Community
 * recorded grants, member-scoped as it always was); or an orphaned one, whose enrolling grant
 * was since revoked or deleted, so no installation holds it any more. The last is how an
 * installation that reconnects under a new grant gets its agent, handle and channels back. An
 * agent whose enrolling grant is still live belongs to another installation and is out of
 * scope. The caller also matches the agent's owner to the grant's member.
 */
export function grantScope(alias: string, grantParam: string): string {
  return `(${alias}.enrolled_by_grant_id=${grantParam} OR ${alias}.enrolled_by_grant_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM connection_grants live WHERE live.id=${alias}.enrolled_by_grant_id
      AND live.community_id=${alias}.community_id AND live.revoked_at IS NULL))`;
}

/** Whether a grant of `memberId` may act on this agent: in the grant's scope, and its member's. */
export function grantActsOn(row: { owner_member_id: string; in_scope: boolean }, memberId: string) {
  return row.in_scope && row.owner_member_id === memberId;
}
