/** Exact existing detached delivery selection, shared by HTTP observation and dispatch. */
export function isDetachedAgentSubject(subject: string): boolean {
  return subject.startsWith('relay.agent.');
}
