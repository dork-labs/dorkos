/**
 * The birth-certificate line (M4): a quiet one-line adornment that opens a
 * newborn agent's very first session — "★ {name} · born {date} · lives in
 * {path} · runs on {runtime}". It is a session header adornment, NOT a message,
 * so it never masquerades as something the agent or the person said.
 *
 * It renders only while the active session carries a birth record (ephemeral,
 * one page session, keyed by session id), so it appears at the birth and never
 * again on the agent's later conversations.
 *
 * @module features/chat/ui/BirthCertificate
 */
import { motion, useReducedMotion } from 'motion/react';
import { Star } from 'lucide-react';
import { useAgentBirthRecord } from '@/layers/shared/model';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';

/** Format an ISO timestamp as a short, human "born" date (e.g. "Jul 20, 2026"). */
function formatBornDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * The birth-certificate line for a session, or nothing when the session has no
 * birth record.
 *
 * @param props.sessionId - The active session id (or null).
 */
export function BirthCertificate({ sessionId }: { sessionId: string | null }) {
  const record = useAgentBirthRecord(sessionId);
  const reducedMotion = useReducedMotion();
  if (!record) return null;

  const bornDate = formatBornDate(record.bornAt);
  const runtimeLabel = getRuntimeDescriptor(record.runtime).label;

  return (
    <motion.div
      initial={reducedMotion ? false : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      data-testid="birth-certificate"
      className="text-muted-foreground flex items-center justify-center gap-1.5 px-4 pt-3 pb-1 text-xs"
    >
      <Star className="text-primary size-3.5 shrink-0 fill-current" aria-hidden="true" />
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="text-foreground font-medium">{record.displayName}</span>
        {bornDate && (
          <>
            <Separator />
            <span>born {bornDate}</span>
          </>
        )}
        <Separator />
        <span className="min-w-0 truncate">
          lives in <code className="text-[0.7rem]">{record.path}</code>
        </span>
        <Separator />
        <span className="shrink-0">runs on {runtimeLabel}</span>
      </span>
    </motion.div>
  );
}

/** A calm mid-dot divider between certificate fields. */
function Separator() {
  return (
    <span aria-hidden="true" className="text-muted-foreground/50 shrink-0">
      ·
    </span>
  );
}
