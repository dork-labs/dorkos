/**
 * The handle a person recognizes an agent by, from whatever the request carried.
 *
 * An approval's `requestedBy` is a display LABEL, not a path — but an agent that
 * set no display name falls back to its own path, so the value is sometimes one
 * and sometimes the other. Taking the last segment reads correctly either way: a
 * plain name has no separator to trim.
 *
 * @param requestedBy - Whoever asked, as the approval recorded it.
 * @returns The last path segment, or the label unchanged.
 */
export function agentLabelFrom(requestedBy: string): string {
  return requestedBy.split('/').filter(Boolean).pop() ?? requestedBy;
}
