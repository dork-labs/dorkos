/** Keep the server’s person-readable refusal when a settings write is refused. */
export function describeWriteFailure(err: unknown): string {
  return (err instanceof Error && err.message) || 'Couldn’t save that. Try again.';
}
