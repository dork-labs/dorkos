/**
 * One burst of Activity, collapsed: the same agent doing the same kind of
 * thing three or more times in a row, read as one line until asked to open.
 *
 * @module features/inbox/ui/InboxGroupRow
 */
import { useId } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { motion } from 'motion/react';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { cn, formatCompactAge } from '@/layers/shared/lib';
import { AgentAvatar, resolveAgentVisual, type AgentVisualSource } from '@/layers/entities/agent';
import { NOTIFICATION_ICONS, notificationBurstVerb } from '@/layers/entities/notifications';
import type { InboxGroupItem } from '../lib/group-activity-rows';
import { GLYPH_SLOT_CLASS, InboxRow, staggerItem } from './InboxRow';

export interface InboxGroupRowProps {
  /** The run this header summarises. */
  group: InboxGroupItem;
  /**
   * The agent behind `group.agentId`, when the caller holds the roster — the
   * same three-state contract `InboxRow` takes: absent, `null` (looked, not
   * found) or a resolved manifest.
   */
  agent?: AgentVisualSource | null;
  /**
   * What to call that agent in the header — "«Agent» finished 4 runs".
   *
   * A separate string rather than read off `agent` here: `AgentVisualSource`
   * is deliberately the minimal shape a face needs (id/colour/icon) so
   * `InboxRow` never has to import the full roster type, and a display name
   * is not part of that. The caller already holds the roster's own
   * `AgentManifest` before it narrows to a face for `agent` below, so it
   * resolves the name once via `getAgentDisplayName` and hands over the
   * string instead of a second, wider agent type just for this one line.
   */
  agentName: string;
  /**
   * Whether the member rows are showing.
   *
   * Owned by the caller (`InboxList`), not this component — see the class
   * doc's own note on why expand state cannot live here.
   */
  expanded: boolean;
  /** Toggle {@link expanded}. Marks nothing read — see the class doc. */
  onToggleExpanded: () => void;
  /**
   * What opening one of the group's OWN rows does, once expanded — the same
   * mark-read-then-navigate the top-level list already runs. Never called by
   * the header itself: opening the group is a look, not a read.
   */
  onOpenNotification: (notification: NotificationDTO) => void;
}

/**
 * A burst, collapsed to one row until clicked open.
 *
 * **Opening it marks nothing.** The header's own click calls
 * {@link InboxGroupRowProps.onToggleExpanded} and nothing else — no query, no
 * read — which is what keeps a curious glance at "what were those 4 runs"
 * from silently clearing a dot the operator has not actually looked at yet.
 * Each member row underneath keeps its own read state and its own click,
 * unchanged from a row drawn on its own: `InboxRow` again, not a lighter
 * copy of it. Every member is groupable by construction — see
 * `group-activity-rows.ts`'s `isGroupableKind` — so every member has
 * somewhere to go, and this draws every one of them as a live row with no
 * conditional fallback to a non-interactive branch.
 *
 * **Expand state lives one level up, in `InboxList`, not here.** It used to
 * be this component's own `useState`, keyed by React's own `key={group.id}`
 * — which broke the moment "Load more" grew a run backward or the live cap
 * trimmed one, either of which changes `group.id` (see its own doc) and
 * silently re-collapses an open group by remounting a fresh component under
 * a new key (caught in review round 1). `InboxList` instead tracks
 * expansion in a `Set` keyed by `group.stateKey` — see that field's own doc
 * for why the shape (`agentId:kind:tone`) alone was not enough either (round
 * 2: two non-adjacent same-shape streaks collided into one Set entry) — and
 * this component just draws whatever `expanded` it is handed.
 *
 * **The header borrows `InboxRow`'s tone rule exactly.** An error-tone group
 * keeps the coloured kind glyph; anything else with a resolved agent draws
 * that agent's face, in the same fixed-width slot `InboxRow` uses
 * ({@link GLYPH_SLOT_CLASS}). The two can never drift apart because the
 * header reads `group.tone`, which the fold that built the group computed
 * with the same function `InboxRow` uses for a single row.
 *
 * @param props - The {@link InboxGroupRowProps.group}, its resolved
 *   {@link InboxGroupRowProps.agent}, its expansion state, and what opening a
 *   member row does.
 */
export function InboxGroupRow({
  group,
  agent,
  agentName,
  expanded,
  onToggleExpanded,
  onOpenNotification,
}: InboxGroupRowProps) {
  const membersId = useId();
  const Icon = NOTIFICATION_ICONS[group.kind];
  const visual = group.tone !== 'error' && agent != null ? resolveAgentVisual(agent) : null;
  const unread = group.notifications.some((notification) => notification.readAt === undefined);
  // Newest first, same as the source list — the first element is the most
  // recent member, whose age is what the header reports.
  const newest = group.notifications[0];
  const title = `${agentName} ${notificationBurstVerb(group.kind, group.notifications.length)}`;
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <motion.div variants={staggerItem} className="min-w-0">
      <button
        type="button"
        data-slot="inbox-row"
        data-inbox-group
        data-expanded={expanded ? 'true' : 'false'}
        data-unread={unread ? 'true' : 'false'}
        aria-expanded={expanded}
        // Only points somewhere when there is somewhere to point: the member
        // rows only exist in the DOM while `expanded`, and `aria-controls`
        // naming an id nothing carries is worse than omitting it.
        aria-controls={expanded ? membersId : undefined}
        onClick={onToggleExpanded}
        className="hover:bg-accent/50 focus-visible:ring-ring/60 flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1 text-left transition-colors outline-none focus-visible:ring-2"
      >
        {/* Identical column to `InboxRow`'s own dot — lit if ANY member is
            still unread, so collapsing a burst never hides the one thing in
            it the operator has not seen. */}
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            unread ? 'bg-status-info' : 'bg-transparent'
          )}
        />
        {unread && <span className="sr-only">Unread. </span>}
        <span data-slot="inbox-row-glyph" className={GLYPH_SLOT_CLASS}>
          {visual ? (
            <AgentAvatar color={visual.color} emoji={visual.emoji} size="xs" badge={null} />
          ) : (
            <Icon
              aria-hidden
              className={cn(
                'size-3.5',
                group.tone === 'error'
                  ? 'text-status-error/70'
                  : group.tone === 'warning'
                    ? 'text-status-warning/70'
                    : 'text-muted-foreground'
              )}
            />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'block truncate text-xs',
              unread ? 'text-foreground font-medium' : 'text-foreground/90'
            )}
          >
            {title}
          </span>
        </span>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {formatCompactAge(newest.createdAt)}
        </span>
        <Chevron aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
      </button>

      {expanded && (
        <div id={membersId} className="border-border/60 ml-[13px] border-l pl-2">
          {group.notifications.map((notification) => (
            <InboxRow
              key={notification.id}
              notification={notification}
              agent={agent}
              onOpen={() => onOpenNotification(notification)}
            />
          ))}
        </div>
      )}
    </motion.div>
  );
}
