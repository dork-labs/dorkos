/**
 * Submit logic for the cockpit feedback dialog (DOR-317, ADR 260713-143958
 * Phase 5).
 *
 * Owns the small idle → submitting state and the single call to
 * `transport.sendFeedback`, tagging the submission with the current route so the
 * team can see where feedback came from. The transport never throws (a network
 * failure is a truthful `{ ok: false }`), so this hook toasts honestly on the
 * result: a thank-you on success, or a nudge toward the GitHub option on
 * failure. Pressing Send IS the consent — nothing here checks a telemetry
 * setting.
 *
 * @module features/feedback/model/use-send-feedback
 */
import { useCallback, useState } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { toast } from 'sonner';
import type { FeedbackSubmissionKind } from '@dorkos/shared/telemetry-events';
import { useTransport } from '@/layers/shared/model';

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
 * Hook powering the feedback dialog's submit action.
 *
 * @returns The in-flight flag and a `send` action.
 */
export function useSendFeedback(): UseSendFeedback {
  const transport = useTransport();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const send = useCallback(
    async (draft: FeedbackDraft): Promise<boolean> => {
      const message = draft.message.trim();
      if (!message) return false;
      const contact = draft.contact?.trim();

      setIsSubmitting(true);
      try {
        const { ok } = await transport.sendFeedback({
          kind: draft.kind,
          message,
          ...(contact ? { contact } : {}),
          ...(pathname ? { route: pathname } : {}),
        });
        if (ok) {
          toast.success('Thanks, sent.');
        } else {
          toast.error("Couldn't send — try the GitHub option.");
        }
        return ok;
      } finally {
        setIsSubmitting(false);
      }
    },
    [transport, pathname]
  );

  return { isSubmitting, send };
}
