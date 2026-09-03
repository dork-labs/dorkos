/**
 * Everything about one session that does not fit on its row.
 *
 * Its id, when it started, when it last moved, which runtime and account it
 * belongs to, what started it, and whether it is allowed to act without asking.
 * Extracted from `SessionRowFull` so the sidebar-grammar row can open the same
 * panel rather than grow a second copy of it — two panels would be two places
 * for "what does this session actually have permission to do" to drift.
 *
 * **The id matters most in the Obsidian embed.** That surface has no router and
 * no address bar, so this is the only place a session's id can be read or
 * copied at all.
 *
 * @module entities/session/ui/SessionDetailsPanel
 */
import { motion, AnimatePresence } from 'motion/react';
import { GitFork } from 'lucide-react';
import type { Session } from '@dorkos/shared/types';
import { cn, permissionModeLabel } from '@/layers/shared/lib';
import { CopyButton, TRUST_TONE_TEXT } from '@/layers/shared/ui';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import { useSessionPermissionSummary } from '../model/use-session-permission-summary';
import { getOriginDescriptor } from '../config/origin-descriptors';

/** Props for {@link SessionDetailsPanel}. */
export interface SessionDetailsPanelProps {
  /** The session being described. */
  session: Session;
  /** Whether the panel is open. It animates its own height either way. */
  expanded: boolean;
  /** Optional fork handler. When omitted, the Fork button is hidden. */
  onFork?: (sessionId: string) => void;
  /**
   * Extra classes on the panel body.
   *
   * The separator between the row and this panel lives here rather than in the
   * component: the full row draws a hairline above it, and the sidebar-grammar
   * row draws none at all — separation there is tint and never a line (spec
   * `sidebar-now-today-library` R1).
   */
  className?: string;
}

/** Format an ISO timestamp for display, falling back to the raw string. */
function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/**
 * The expandable detail block under a session row.
 *
 * **It reads the permission summary itself, and its caller reads it too.** That
 * duplication is deliberate: `SessionRowFull` and `SessionRowSidebar` both need
 * `isFullPower` for the full-power mark on the row face, and this needs the mode in
 * words.
 * Both calls land on the same two cached reads — a `enabled: false` session
 * query and one `staleTime: Infinity` capability map the shell has already
 * mounted — so the second costs a map lookup and nothing else. Passing it down
 * as a prop instead would make every caller responsible for deriving a fact this
 * component is perfectly able to ask for, which is how the two got to disagree
 * before there was a hook at all.
 *
 * @param props - The session, whether the block is open, and the fork handler.
 */
export function SessionDetailsPanel({
  session,
  expanded,
  onFork,
  className,
}: SessionDetailsPanelProps) {
  const { permissionMode, isFullPower } = useSessionPermissionSummary(session);
  // The row mark above this panel already announces "Full power" (spec
  // `full-power-defaults`, D8) — the technical mode name (`bypassPermissions`,
  // `always-allow`, …) would be a second register for the same fact. Every
  // OTHER mode still gets its own precise name here: only the bypass case
  // collapses to the umbrella word the rest of the product already uses for it
  // (DOR-1499). Non-bypass modes stay distinct on purpose (DOR-496) — this
  // does not revive the old "is this bypass?" boolean that conflated them.
  const permissionsValue = isFullPower ? 'Full power' : permissionModeLabel(permissionMode);

  return (
    <AnimatePresence initial={false}>
      {expanded && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
          className="relative z-10 overflow-hidden"
          data-slot="session-details-panel"
        >
          <div
            className={cn(
              'text-muted-foreground text-2xs mx-2 space-y-1.5 px-3 pt-2 pb-2',
              className
            )}
          >
            <DetailRow label="Session ID" value={session.id} copyable />
            <DetailRow label="Created" value={formatTimestamp(session.createdAt)} />
            <DetailRow label="Updated" value={formatTimestamp(session.updatedAt)} />
            <DetailRow label="Runtime" value={getRuntimeDescriptor(session.runtime).label} />
            <DetailRow
              label="Origin"
              value={session.originLabel ?? getOriginDescriptor(session.origin)?.label ?? 'You'}
            />
            {/* Green, matching the row face one click above it and every other
                full-power surface. This line and that glyph are the same fact,
                so they cannot be two colours (spec `full-power-defaults`, D8). */}
            <DetailRow
              label="Permissions"
              value={permissionsValue}
              valueClassName={isFullPower ? TRUST_TONE_TEXT.power : undefined}
            />
            {onFork && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onFork(session.id);
                }}
                className="hover:bg-secondary/80 text-muted-foreground/60 hover:text-muted-foreground mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors duration-100"
                aria-label="Fork session"
              >
                <GitFork className="size-(--size-icon-xs)" />
                <span>Fork</span>
              </button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** One labelled fact about the session. */
function DetailRow({
  label,
  value,
  copyable = false,
  valueClassName,
}: {
  label: string;
  value: string;
  copyable?: boolean;
  /** Extra classes for the value, e.g. a warning tint on a risky setting. */
  valueClassName?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground/60 w-16 flex-shrink-0">{label}</span>
      <span className={cn('min-w-0 flex-1 truncate font-mono select-all', valueClassName)}>
        {value}
      </span>
      {copyable && <CopyButton value={value} label={`Copy ${label}`} />}
    </div>
  );
}
