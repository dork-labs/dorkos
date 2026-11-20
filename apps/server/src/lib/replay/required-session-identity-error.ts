/** A billing/identity carry failure must stop alias adoption, unlike optional replay decoration. */
export class RequiredSessionIdentityError extends Error {
  /** Preserve the original cause without exposing it in shared room copy. */
  constructor(cause: unknown) {
    super('Required session identity could not be preserved.', { cause });
  }
}
