/**
 * Submit logic for the app's feedback dialog (DOR-317, ADR 260713-143958
 * Phase 5; diagnostics + transcript + anonymous plumbing per feedback-pipeline
 * spec Part 5).
 *
 * Owns the small idle → submitting state and the single call to
 * `transport.sendFeedback`, tagging the submission with the current route —
 * pathname plus an ALLOWLISTED query string, so `/session?session=abc` names
 * the conversation rather than degrading to a bare `/session`, while `?dir=`
 * and `?prompt=` never ride along (DOR-1960; the allowlist and its reasoning
 * live in `../lib/feedback-route`) — and (when the "Conversation" toggle is
 * on) the session the transcript should come from. The dialog decides WHAT to
 * attach; this hook turns those choices into the wire submission:
 *   - `includeDiagnostics` → attaches the safe `clientReport` subset the GitHub
 *     path already shows the user, plus the in-memory breadcrumb trail (and, for
 *     a crash report, the stack trace as a breadcrumb).
 *   - `includeDiagnostics` on a `kind === 'bug'` submission → sets
 *     `includeServerLogs` so the server gathers and attaches a scrubbed log
 *     excerpt (the client never reads the log file itself). Inside the desktop
 *     app the same reports also carry `diagnostics.shellLogExcerpt`, the SHELL's
 *     own log — the one thing the server cannot gather, because it lives in the
 *     Electron main process (DOR-2045).
 *   - `includeConversation` (only when a `sessionId` is resolvable from the
 *     route) → sets `sessionId` + `includeTranscript` so the server gathers and
 *     attaches a bounded, scrubbed transcript excerpt.
 *   - `screenshotDataUrl` → becomes the `screenshot` attachment, already
 *     downscaled and bounded by `compressImage` before it reaches this hook.
 *   - `anonymous` → tells the server to skip its identity lookup.
 *   - `element` → the one element the person pointed at, as its own field. It
 *     never adds a word to `message` (DOR-2232).
 *
 * The transport never throws (a network failure is a truthful `{ ok: false }`),
 * so this hook toasts honestly on the result: a thank-you that says what happens
 * next and links to the person's own reports on success, or a nudge toward the
 * GitHub option on failure. The same report sent twice within a minute is caught
 * here rather than filed twice. Pressing Send IS the consent — nothing here
 * checks a telemetry setting.
 *
 * @module features/feedback/model/use-send-feedback
 */
import { useCallback, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  MAX_BREADCRUMBS,
  MAX_BREADCRUMB_MESSAGE_LEN,
  type FeedbackDiagnostics,
  type FeedbackElement,
  type FeedbackSubmissionKind,
} from '@dorkos/shared/telemetry-events';
import type { ServerConfig } from '@dorkos/shared/schemas';
import { useTransport, useResolvedTheme, type ResolvedTheme } from '@/layers/shared/model';
import {
  buildClientReport,
  captureClientEnvironment,
  getBreadcrumbs,
  getDesktopShellLogExcerpt,
  redactBreadcrumb,
} from '@/layers/shared/lib';
import { configKeys } from '@/layers/entities/config';
import { buildFeedbackRoute } from '../lib/feedback-route';

/** Where the person's own reports live — "Your reports" in the help menu. */
const YOUR_REPORTS_PATH = '/feedback-requests';

/**
 * How long the same report counts as the same report. Long enough to catch a
 * second press after a slow send (two of one person's reports were 33 seconds
 * apart), short enough that sending it again on purpose later still works.
 */
const DUPLICATE_WINDOW_MS = 60_000;

/** What happens next, per kind, in the thank-you toast. */
const WHEN_WE_WRITE: Record<FeedbackSubmissionKind, string> = {
  bug: 'when it’s fixed',
  idea: 'when it ships',
  feedback: 'when we act on it',
};

/**
 * What makes two submissions the same report: the kind, the words, and what was
 * attached. Diagnostics and the page are left out on purpose, because they drift
 * between two presses of the same button.
 */
function fingerprint(draft: FeedbackDraft, message: string): string {
  return JSON.stringify([
    draft.kind,
    message,
    draft.screenshotDataUrl ?? null,
    draft.element?.selector ?? null,
  ]);
}

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
  /**
   * The compressed `data:` URL of the one screenshot the user attached, already
   * bounded by `compressImage`. Becomes the submission's `screenshot` field; the
   * server derives the `hasScreenshot` hint from its presence, so nothing here
   * sets that flag itself.
   */
  screenshotDataUrl?: string;
  /** Send without a reporter identity even when signed in. */
  anonymous?: boolean;
  /** A crash stack to fold into diagnostics as a breadcrumb (crash reports). */
  crashStack?: string;
  /** The one element the person pointed at, sent as its own field. */
  element?: FeedbackElement;
  /**
   * The address the team will write back to, when there is one, for the
   * thank-you toast to name. Display only: it never goes on the wire, where the
   * server resolves identity and `contact` carries a typed address.
   */
  notifyEmail?: string;
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
   * The page address this submission will record: the pathname plus the
   * allowlisted query params {@link buildFeedbackRoute} keeps. Exposed so the
   * preview can show the same string that `send` transmits — it rides outside
   * the Diagnostics toggle (a coarse route always has), so the preview is the
   * only place a person can see it before pressing Send.
   */
  route: string;
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
 * and, for a crash report, the stack trace as a trailing breadcrumb, redacted
 * the same way the collected ones are.
 *
 * Also folds in {@link captureClientEnvironment}'s window/browser/shell/theme/
 * locale/timezone snapshot (DOR-1960) — the "what was on screen" half of the
 * bundle, which the GitHub-path report has no slot for.
 *
 * @param config - The cached server config, or `undefined` while still loading.
 * @param pathname - The active route path, for the same report `buildClientReport` builds.
 * @param theme - The color scheme in effect, already resolved from the preference.
 * @param crashStack - An optional stack trace to fold in as a breadcrumb.
 */
function buildFeedbackDiagnostics(
  config: ServerConfig | undefined,
  pathname: string,
  theme: ResolvedTheme,
  crashStack?: string
): FeedbackDiagnostics {
  const report = buildClientReport('bug', config, pathname);
  const breadcrumbs = [...getBreadcrumbs()];
  if (crashStack) {
    breadcrumbs.push({
      at: new Date().toISOString(),
      kind: 'console_error',
      // Scrubbed like every other breadcrumb: a stack trace names files by
      // their full path, home directory and all.
      message: redactBreadcrumb(crashStack).slice(0, MAX_BREADCRUMB_MESSAGE_LEN),
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
      // Window size, browser, shell, theme, locale and timezone (DOR-1960).
      // Captured HERE rather than in `buildClientReport`, which builds the
      // GitHub-issue-URL shape and has no slot for any of them.
      ...captureClientEnvironment(theme),
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
  // The serialized query string (`?session=abc`), kept separate from `pathname`
  // because only the submission's `route` wants the two joined — the GitHub
  // report's `surface` line stays pathname-only.
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const resolvedTheme = useResolvedTheme();
  // Built once here so `send` and the preview cannot disagree about what the
  // recorded address is.
  const route = buildFeedbackRoute(pathname, searchStr);
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
  const navigate = useNavigate();
  // The last report that went through, and when. A ref rather than module state:
  // the dialog host is mounted for the life of the app, so this outlives every
  // open and close, and nothing outside this one dialog can see or reset it.
  const lastSent = useRef<{ fingerprint: string; at: number } | null>(null);

  const buildDiagnostics = useCallback(
    (opts?: { crashStack?: string }) =>
      config
        ? buildFeedbackDiagnostics(config, pathname, resolvedTheme, opts?.crashStack)
        : undefined,
    [config, pathname, resolvedTheme]
  );

  const send = useCallback(
    async (draft: FeedbackDraft): Promise<boolean> => {
      const message = draft.message.trim();
      if (!message) return false;
      const contact = draft.contact?.trim();

      const print = fingerprint(draft, message);
      const previous = lastSent.current;
      if (
        previous &&
        previous.fingerprint === print &&
        Date.now() - previous.at < DUPLICATE_WINDOW_MS
      ) {
        // Already with the team. Resolving `true` closes the dialog as if it had
        // gone again, which is what the person wanted; filing it twice is not.
        toast.info('You sent this a moment ago, so we didn’t send it again.');
        return true;
      }

      const diagnostics = draft.includeDiagnostics
        ? buildFeedbackDiagnostics(config, pathname, resolvedTheme, draft.crashStack)
        : undefined;
      const includeServerLogs = draft.includeDiagnostics && draft.kind === 'bug';
      const attachConversation = Boolean(draft.includeConversation && sessionId);

      setIsSubmitting(true);
      try {
        // The desktop shell's own log, on exactly the reports the server log
        // rides on (DOR-2045). Gathered HERE rather than server-side, unlike
        // every other field in this bundle, because `main.log` belongs to the
        // Electron main process and the server child cannot see it. `undefined`
        // everywhere else, including on a desktop build older than the bridge
        // method — and inside the in-flight state, because it is an IPC round
        // trip the person should see the app waiting on.
        const shellLogExcerpt =
          diagnostics && includeServerLogs ? await getDesktopShellLogExcerpt() : undefined;
        const { ok } = await transport.sendFeedback({
          kind: draft.kind,
          message,
          ...(contact ? { contact } : {}),
          ...(route ? { route } : {}),
          ...(diagnostics
            ? { diagnostics: { ...diagnostics, ...(shellLogExcerpt ? { shellLogExcerpt } : {}) } }
            : {}),
          ...(includeServerLogs ? { includeServerLogs: true } : {}),
          ...(attachConversation ? { sessionId, includeTranscript: true } : {}),
          ...(draft.screenshotDataUrl ? { screenshot: { dataUrl: draft.screenshotDataUrl } } : {}),
          ...(draft.anonymous ? { anonymous: true } : {}),
          ...(draft.element ? { element: draft.element } : {}),
        });
        if (ok) {
          lastSent.current = { fingerprint: print, at: Date.now() };
          toast.success('Sent. Thank you!', {
            ...(draft.notifyEmail
              ? { description: `We’ll email ${draft.notifyEmail} ${WHEN_WE_WRITE[draft.kind]}.` }
              : {}),
            action: {
              label: 'Your reports',
              // The route is not in the typed router table, so navigate is
              // loosened here on purpose, as the help menu does.
              onClick: () =>
                (navigate as (opts: { to: string }) => void)({ to: YOUR_REPORTS_PATH }),
            },
          });
        } else {
          toast.error(
            'Couldn’t send. Your words are still here, so try again or open a GitHub issue instead.'
          );
        }
        return ok;
      } finally {
        setIsSubmitting(false);
      }
    },
    [transport, pathname, route, sessionId, config, resolvedTheme, navigate]
  );

  return { isSubmitting, sessionId, route, buildDiagnostics, send };
}
