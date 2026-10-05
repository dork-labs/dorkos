/**
 * What the connect dialog says when a connection can't start, read from the
 * stable codes the server answers with — never from a service's own text,
 * which is written for its logs.
 *
 * The rule both answers share: offer "try again" only when trying again could
 * work. A refusal the service gave for good, or a way to connect that isn't
 * set up, ends the same way every time, so it gets an explanation and the one
 * action that helps instead.
 *
 * @module features/connections/lib/connect-failure
 */
import type { ConnectStartRefusal } from '@dorkos/shared/connector-provider';

/** Copy for a connection that could not start. */
export interface ConnectFailureCopy {
  /** The one-line headline. */
  title: string;
  /** What it means and what to do next. */
  description: string;
  /** Whether starting again could succeed. False hides the retry. */
  canRetry: boolean;
  /** Present when the fix is linking this computer to its DorkOS account again. */
  action?: 'relink';
}

/**
 * Copy for a start the service refused for good (a `failed` flow carrying a
 * `failureCode`).
 *
 * @param refusal - The flow's `failureCode`.
 * @param serviceName - The app's display name, e.g. `Slack`.
 */
export function connectRefusalCopy(
  refusal: ConnectStartRefusal,
  serviceName: string
): ConnectFailureCopy {
  switch (refusal) {
    case 'service_not_ready':
      return {
        title: `${serviceName} can’t be connected yet`,
        description: 'This isn’t something you can fix here.',
        canRetry: false,
      };
    case 'account_link_required':
      return {
        title: 'This computer isn’t linked to DorkOS',
        description: 'Link your DorkOS account again, then connect.',
        canRetry: false,
        action: 'relink',
      };
    case 'service_unavailable':
      return {
        title: `${serviceName} isn’t available right now`,
        description: 'Nothing was connected. Try again in a few minutes.',
        canRetry: true,
      };
  }
}

/** Server codes for a start refused before any service was asked. Trying again won't help. */
const WAY_NOT_WORKING = new Set(['provider_not_found', 'authentication_unavailable']);

/**
 * Copy for a start request that itself failed (the mutation's error).
 *
 * @param error - The error the start mutation settled with.
 * @param serviceName - The app's display name.
 */
export function startErrorCopy(error: unknown, serviceName: string): ConnectFailureCopy {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (typeof code === 'string' && WAY_NOT_WORKING.has(code)) {
    return {
      title: 'Couldn’t start the connection',
      description: `The way DorkOS reaches ${serviceName} isn’t working. Check Settings › Connections.`,
      canRetry: false,
    };
  }
  // No answer, a timeout or a server fault: these pass, so the retry stays.
  return {
    title: 'Couldn’t start the connection',
    description: 'Nothing was connected. Try again in a moment.',
    canRetry: true,
  };
}
