/** Only the person-alone browser may use the existing embedded sign-ins. */
export function isPersonBrowserOpen(input: { sessionId?: unknown; profileId?: unknown }): boolean {
  return input.sessionId === null && input.profileId === null;
}
