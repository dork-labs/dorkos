/**
 * Plain copy for a refused DorkOS-account call, read from the stable `code`
 * the server answers with, so a surface can say where the problem is and
 * offer the one action that helps.
 *
 * @module entities/connectors/lib/cloud-failure
 */

/** Copy for one DorkOS-account refusal. */
export interface CloudFailureCopy {
  title: string;
  description: string;
  /** Present only when there is one useful action: link the DorkOS account again. */
  action?: 'relink';
}

const COPY: Record<string, CloudFailureCopy> = {
  cloud_link_required: {
    title: 'This computer isn’t linked to DorkOS',
    description: 'Link your DorkOS account again to keep using this app. Nothing changed.',
    action: 'relink',
  },
  cloud_link_needs_update: {
    title: 'This computer’s link needs updating',
    description: 'Link your DorkOS account again to pick up the update. Nothing changed.',
    action: 'relink',
  },
  cloud_unavailable: {
    title: 'DorkOS’s servers aren’t answering',
    description: 'Nothing changed. Try again in a few minutes.',
  },
  cloud_refused: {
    title: 'DorkOS’s servers couldn’t finish this',
    description: 'Nothing changed on this computer. Try again later.',
  },
};

/**
 * Read the failure copy for one query or mutation error.
 *
 * @param error - The error a query or mutation settled with.
 * @returns The copy for a known DorkOS-account refusal, or `null` to keep the surface's own copy.
 */
export function cloudFailure(error: unknown): CloudFailureCopy | null {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === 'string' && Object.hasOwn(COPY, code) ? COPY[code]! : null;
}
