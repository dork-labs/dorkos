/** Pure host-observed boundary classification; does not create, retain, or revive frame authority. */
export interface DevtoolsFrameContext {
  frame: Window | null | undefined;
  sessionId: string | null;
  documentId: string;
  logicalUrl: string;
  source: string | null;
  eligibility: 'served-document' | 'preview-listener' | null;
  origin: string | null;
  reload: number;
}

/** An attribution-only change retires DevTools work without retiring the sibling Doc load. */
export function classifyDevtoolsFrameChange(
  previous: DevtoolsFrameContext | null,
  next: DevtoolsFrameContext
) {
  const changed =
    !previous ||
    Object.keys(next).some(
      (key) => next[key as keyof typeof next] !== previous[key as keyof typeof next]
    );
  const pageChanged =
    !previous ||
    previous.frame !== next.frame ||
    previous.documentId !== next.documentId ||
    previous.logicalUrl !== next.logicalUrl ||
    previous.source !== next.source ||
    previous.reload !== next.reload;
  const sessionOnlyChanged =
    !!previous &&
    !pageChanged &&
    previous.eligibility === next.eligibility &&
    previous.origin === next.origin;
  return { changed, pageChanged, sessionOnlyChanged };
}
