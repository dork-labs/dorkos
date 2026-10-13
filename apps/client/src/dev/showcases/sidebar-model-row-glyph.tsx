/**
 * The mark at the head of a Sidebar Model showcase row, drawn from the model's
 * semantic glyph — split out of `SidebarModelShowcases.tsx` so that file stays
 * under its line budget.
 *
 * @module dev/showcases/sidebar-model-row-glyph
 */
import {
  AlertTriangle,
  Bot,
  CalendarClock,
  ChevronRight,
  CircleHelp,
  Hash,
  Loader,
  MessageSquarePlus,
  ShieldQuestion,
  Sparkles,
  UserPlus,
} from 'lucide-react';
import { resolveAgentVisual } from '@/layers/shared/lib';
import { ContributedIcon, IdentityAvatar } from '@/layers/shared/ui';
import type {
  SidebarIconId,
  SidebarRowModel,
} from '@/layers/features/dashboard-sidebar/model/build-sidebar-model';
import type { SidebarState } from '@/layers/features/dashboard-sidebar/model/sidebar-state';

/** What each semantic icon id in the model is actually drawn as. */
const ICON: Record<SidebarIconId, typeof Bot> = {
  permission: ShieldQuestion,
  question: CircleHelp,
  error: AlertTriangle,
  schedule: CalendarClock,
  overflow: ChevronRight,
  working: Loader,
  automated: CalendarClock,
  digest: Sparkles,
  'add-agent': UserPlus,
  'first-session': MessageSquarePlus,
  team: Hash,
  dorkbot: Bot,
  session: MessageSquarePlus,
};

/**
 * The mark at the head of a row, from the model's semantic glyph.
 *
 * Every face is drawn from a hash of the identity's own path or id — there is
 * no photo to fetch and no agent to look up, which is what keeps this page
 * working with no server behind it.
 *
 * @param row - The row whose glyph this is.
 * @param state - The snapshot the row came from, for display names.
 */
export function RowGlyph({ row, state }: { row: SidebarRowModel; state: SidebarState }) {
  const { glyph } = row;

  if (glyph.kind === 'icon') {
    const Icon = ICON[glyph.icon];
    return <Icon aria-hidden className="text-sidebar-foreground/60 size-3.5" />;
  }
  if (glyph.kind === 'agent-avatar') {
    const visual = resolveAgentVisual({ id: glyph.agentPath });
    return (
      <IdentityAvatar
        kind="agent"
        size="xs"
        color={visual.color}
        emoji={visual.emoji}
        fallback={(state.displayNames[glyph.agentPath] ?? '?').slice(0, 1).toUpperCase()}
        className="text-3xs size-[18px]"
      />
    );
  }
  if (glyph.kind === 'page-icon') {
    // The playground holds no extension registry entries, so this is the
    // fallback a page with no icon draws: the puzzle piece.
    return (
      <span aria-hidden>
        <ContributedIcon icon={undefined} className="text-sidebar-foreground/60 size-3.5" />
      </span>
    );
  }
  if (glyph.kind === 'hash') {
    return <Hash aria-hidden className="text-sidebar-foreground/60 size-3.5" />;
  }
  // Every glyph kind is answered above. Adding one makes `glyph` something
  // other than `never` here, which is a type error rather than a quiet `#`.
  const unhandled: never = glyph;
  return unhandled;
}
