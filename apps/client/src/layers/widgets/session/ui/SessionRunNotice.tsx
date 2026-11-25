import { RotateCcw } from 'lucide-react';
import type { RunNotice } from '@dorkos/shared/run-schemas';
import { useSessionRunNotice } from '@/layers/entities/session';
import { Notice } from '@/layers/shared/ui';

/** What each run line says (spec `turns-survive-restarts` §7.4). */
export const RUN_NOTICE_LINES: Record<RunNotice, string> = {
  restart_stopped: 'DorkOS restarted during this reply, so it stopped. Send a message to continue.',
};

/**
 * The one line a chat shows about how its last run ended, read from the run
 * record, so every window shows it, including one opened after the restart.
 * Gone once anything newer is sent.
 */
export function SessionRunNotice({ sessionId }: { sessionId: string | null }) {
  const notice = useSessionRunNotice(sessionId ?? '');
  if (!sessionId || notice === null) return null;
  return (
    <div className="mx-4 mb-2">
      <Notice role="status" aria-live="polite" className="flex items-start gap-2">
        {/* mt-0.5 centres the 16px icon on the first 20px line, at any width. */}
        <RotateCcw aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <p>{RUN_NOTICE_LINES[notice]}</p>
      </Notice>
    </div>
  );
}
