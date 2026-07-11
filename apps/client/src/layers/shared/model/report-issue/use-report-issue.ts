/**
 * Hook that opens a prefilled GitHub issue from the cockpit.
 *
 * Reads the server config the cockpit already caches, keeps only safe details
 * (version, host platform, runtimes, current route, on/off settings), and opens
 * `github.com/dork-labs/dorkos/issues/new` in a new tab with the title, body,
 * and label filled in. The user reviews and edits everything in GitHub before
 * submitting. Nothing is sent anywhere.
 *
 * @module shared/model/use-report-issue
 */
import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { buildIssueUrl, type FeedbackKind } from '@dorkos/shared/feedback';
import type { ServerConfig } from '@dorkos/shared/schemas';
import { useTransport } from '../TransportContext';
import { buildClientReport } from '../../lib/build-issue-report';

/**
 * Get a callback that opens a prefilled GitHub issue for the given kind.
 *
 * @returns A stable `reportIssue(kind)` function
 */
export function useReportIssue(): (kind: FeedbackKind) => void {
  const transport = useTransport();
  const { data: config } = useQuery<ServerConfig>({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 5 * 60 * 1000,
  });
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return useCallback(
    (kind: FeedbackKind) => {
      const url = buildIssueUrl(buildClientReport(kind, config, pathname));
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    [config, pathname]
  );
}
