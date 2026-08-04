/**
 * Submit logic for the cockpit feedback dialog (DOR-317, ADR 260713-143958
 * Phase 5; diagnostics attachment per feedback-pipeline spec Part 1).
 *
 * Owns the small idle → submitting state and the single call to
 * `transport.sendFeedback`, tagging the submission with the current route so the
 * team can see where feedback came from. For a `kind === 'bug'` submission, also
 * attaches the same safe `clientReport` subset the GitHub "Report an issue" path
 * already shows the user, plus the in-memory breadcrumb trail — both low
 * sensitivity and already visible elsewhere, so attaching them automatically is
 * safe. `includeServerLogs`/`transcriptExcerpt`/`screenshotUploadId` are NOT set
 * here — those are opt-in through the dialog's diagnostics UI (a later PR); this
 * hook only wires the plumbing they will use.
 *
 * The transport never throws (a network failure is a truthful `{ ok: false }`),
 * so this hook toasts honestly on the result: a thank-you on success, or a
 * nudge toward the GitHub option on failure. Pressing Send IS the consent —
 * nothing here checks a telemetry setting.
 *
 * @module features/feedback/model/use-send-feedback
 */
import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { toast } from 'sonner';
import type { FeedbackDiagnostics, FeedbackSubmissionKind } from '@dorkos/shared/telemetry-events';
import type { ServerConfig } from '@dorkos/shared/schemas';
import { useTransport } from '@/layers/shared/model';
import { buildClientReport, getBreadcrumbs } from '@/layers/shared/lib';

/** A single feedback submission from the dialog. */
export interface FeedbackDraft {
  /** Which kind of feedback: general, a bug, or a feature idea. */
  kind: FeedbackSubmissionKind;
  /** The user-typed message. */
  message: string;
  /** Optional way to reach the user back. */
  contact?: string;
}

/** What {@link useSendFeedback} returns to the dialog. */
export interface UseSendFeedback {
  /** True while a submission is in flight. */
  isSubmitting: boolean;
  /**
   * Send a feedback draft. Resolves `true` when the ingest accepted it (the
   * dialog closes), `false` when it did not (the dialog stays open so the user
   * can retry or copy their text into a GitHub issue). Toasts either way.
   */
  send: (draft: FeedbackDraft) => Promise<boolean>;
}

/**
 * Build the diagnostics bundle a `kind === 'bug'` submission attaches: the same
 * safe subset `buildClientReport` already produces for the GitHub path (version,
 * platform, configured runtimes, on/off flags — dropping `kind`/`surface`,
 * which have no slot in {@link FeedbackDiagnostics.clientReport}), plus the
 * current breadcrumb trail.
 *
 * @param config - The cached server config, or `undefined` while still loading.
 * @param pathname - The active route path, for the same report `buildClientReport` builds.
 */
function buildBugDiagnostics(
  config: ServerConfig | undefined,
  pathname: string
): FeedbackDiagnostics {
  const report = buildClientReport('bug', config, pathname);
  const breadcrumbs = getBreadcrumbs();
  return {
    clientReport: {
      version: report.version,
      platform: report.platform,
      runtimes: report.runtimes,
      // clientReport.flags accepts boolean | string; sanitizeFlags's allowlist
      // has no number-typed flag today, but coerce defensively so a future one
      // degrades to a string instead of failing the schema.
      flags: Object.fromEntries(
        Object.entries(report.flags).map(([key, value]) => [
          key,
          typeof value === 'number' ? String(value) : value,
        ])
      ),
    },
    ...(breadcrumbs.length > 0 ? { breadcrumbs } : {}),
  };
}

/**
 * Hook powering the feedback dialog's submit action.
 *
 * @returns The in-flight flag and a `send` action.
 */
export function useSendFeedback(): UseSendFeedback {
  const transport = useTransport();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: config } = useQuery<ServerConfig>({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 5 * 60 * 1000,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const send = useCallback(
    async (draft: FeedbackDraft): Promise<boolean> => {
      const message = draft.message.trim();
      if (!message) return false;
      const contact = draft.contact?.trim();
      const diagnostics = draft.kind === 'bug' ? buildBugDiagnostics(config, pathname) : undefined;

      setIsSubmitting(true);
      try {
        const { ok } = await transport.sendFeedback({
          kind: draft.kind,
          message,
          ...(contact ? { contact } : {}),
          ...(pathname ? { route: pathname } : {}),
          ...(diagnostics ? { diagnostics } : {}),
        });
        if (ok) {
          toast.success('Thanks, sent.');
        } else {
          toast.error("Couldn't send. Try the GitHub option.");
        }
        return ok;
      } finally {
        setIsSubmitting(false);
      }
    },
    [transport, pathname, config]
  );

  return { isSubmitting, send };
}
