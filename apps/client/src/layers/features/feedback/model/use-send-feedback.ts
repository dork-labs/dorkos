/**
 * Submit logic for the cockpit feedback dialog (DOR-317, ADR 260713-143958
 * Phase 5; diagnostics + transcript + anonymous plumbing per feedback-pipeline
 * spec Part 5).
 *
 * Owns the small idle → submitting state and the single call to
 * `transport.sendFeedback`, tagging the submission with the current route and
 * (when the "Conversation" toggle is on) the session the transcript should come
 * from. The dialog decides WHAT to attach; this hook turns those choices into
 * the wire submission:
 *   - `includeDiagnostics` → attaches the safe `clientReport` subset the GitHub
 *     path already shows the user, plus the in-memory breadcrumb trail (and, for
 *     a crash report, the stack trace as a breadcrumb).
 *   - `includeDiagnostics` on a `kind === 'bug'` submission → sets
 *     `includeServerLogs` so the server gathers and attaches a scrubbed log
 *     excerpt (the client never reads the log file itself).
 *   - `includeConversation` (only when a `sessionId` is resolvable from the
 *     route) → sets `sessionId` + `includeTranscript` so the server gathers and
 *     attaches a bounded, scrubbed transcript excerpt.
 *   - `anonymous` → tells the server to skip its identity lookup.
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
import {
  MAX_BREADCRUMBS,
  MAX_BREADCRUMB_MESSAGE_LEN,
  type FeedbackDiagnostics,
  type FeedbackSubmissionKind,
} from '@dorkos/shared/telemetry-events';
import type { ServerConfig } from '@dorkos/shared/schemas';
import { useTransport } from '@/layers/shared/model';
import { buildClientReport, getBreadcrumbs } from '@/layers/shared/lib';
import { configKeys } from '@/layers/entities/config';

/** A single feedback submission from the dialog. */
export interface FeedbackDraft {
  /** Which kind of feedback: general, a bug, or a feature idea. */
  kind: FeedbackSubmissionKind;
  /** The user-typed message. */
  message: string;
  /** Optional way to reach the user back. */
  contact?: string;
  /** Attach the client diagnostics bundle (clientReport + breadcrumbs). */
  includeDiagnostics?: boolean;
  /** Attach the current session's transcript excerpt (server-gathered). */
  includeConversation?: boolean;
  /** Send without a reporter identity even when signed in. */
  anonymous?: boolean;
  /** A crash stack to fold into diagnostics as a breadcrumb (crash reports). */
  crashStack?: string;
}

/** What {@link useSendFeedback} returns to the dialog. */
export interface UseSendFeedback {
  /** True while a submission is in flight. */
  isSubmitting: boolean;
  /**
   * The session id resolvable from the current route (`/session?session=…`), or
   * `undefined` off a session route. The dialog shows the "Conversation" toggle
   * only when this is set (there is nothing to attach otherwise).
   */
  sessionId: string | undefined;
  /**
   * Build the diagnostics bundle that WOULD be attached right now — the exact
   * `clientReport` + breadcrumbs the full preview shows and `send` transmits, so
   * the two can never diverge. `undefined` while the config is still loading.
   */
  buildDiagnostics: (opts?: { crashStack?: string }) => FeedbackDiagnostics | undefined;
  /**
   * Send a feedback draft. Resolves `true` when the ingest accepted it (the
   * dialog closes), `false` when it did not (the dialog stays open so the user
   * can retry or copy their text into a GitHub issue). Toasts either way.
   */
  send: (draft: FeedbackDraft) => Promise<boolean>;
}

/**
 * Build the client diagnostics bundle: the same safe subset `buildClientReport`
 * produces for the GitHub path (version, platform, configured runtimes, on/off
 * flags — dropping `kind`/`surface`, which have no slot in
 * {@link FeedbackDiagnostics.clientReport}), plus the current breadcrumb trail
 * and, for a crash report, the stack trace as a trailing breadcrumb.
 *
 * @param config - The cached server config, or `undefined` while still loading.
 * @param pathname - The active route path, for the same report `buildClientReport` builds.
 * @param crashStack - An optional stack trace to fold in as a breadcrumb.
 */
function buildFeedbackDiagnostics(
  config: ServerConfig | undefined,
  pathname: string,
  crashStack?: string
): FeedbackDiagnostics {
  const report = buildClientReport('bug', config, pathname);
  const breadcrumbs = [...getBreadcrumbs()];
  if (crashStack) {
    breadcrumbs.push({
      at: new Date().toISOString(),
      kind: 'console_error',
      message: crashStack.slice(0, MAX_BREADCRUMB_MESSAGE_LEN),
    });
  }
  // Keep newest within the schema bound if a crash breadcrumb pushed us over.
  const bounded = breadcrumbs.slice(-MAX_BREADCRUMBS);
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
    ...(bounded.length > 0 ? { breadcrumbs: bounded } : {}),
  };
}

/**
 * Hook powering the feedback dialog's submit action.
 *
 * @returns The in-flight flag, the resolvable session id, a diagnostics-preview
 *   builder, and a `send` action.
 */
export function useSendFeedback(): UseSendFeedback {
  const transport = useTransport();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const sessionId = useRouterState({
    select: (s) => {
      const search = s.location.search as { session?: string } | undefined;
      return typeof search?.session === 'string' ? search.session : undefined;
    },
  });
  const { data: config } = useQuery<ServerConfig>({
    queryKey: configKeys.current(),
    queryFn: () => transport.getConfig(),
    staleTime: 5 * 60 * 1000,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const buildDiagnostics = useCallback(
    (opts?: { crashStack?: string }) =>
      config ? buildFeedbackDiagnostics(config, pathname, opts?.crashStack) : undefined,
    [config, pathname]
  );

  const send = useCallback(
    async (draft: FeedbackDraft): Promise<boolean> => {
      const message = draft.message.trim();
      if (!message) return false;
      const contact = draft.contact?.trim();

      const diagnostics = draft.includeDiagnostics
        ? buildFeedbackDiagnostics(config, pathname, draft.crashStack)
        : undefined;
      const includeServerLogs = draft.includeDiagnostics && draft.kind === 'bug';
      const attachConversation = Boolean(draft.includeConversation && sessionId);

      setIsSubmitting(true);
      try {
        const { ok } = await transport.sendFeedback({
          kind: draft.kind,
          message,
          ...(contact ? { contact } : {}),
          ...(pathname ? { route: pathname } : {}),
          ...(diagnostics ? { diagnostics } : {}),
          ...(includeServerLogs ? { includeServerLogs: true } : {}),
          ...(attachConversation ? { sessionId, includeTranscript: true } : {}),
          ...(draft.anonymous ? { anonymous: true } : {}),
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
    [transport, pathname, sessionId, config]
  );

  return { isSubmitting, sessionId, buildDiagnostics, send };
}
