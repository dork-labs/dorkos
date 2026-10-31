/**
 * The two unread tiers on the sidebar's own row, and the count pill the second
 * one draws — split from `SidebarModelShowcases.tsx`, which renders both.
 *
 * @module dev/showcases/SidebarUnreadTiersShowcase
 */
import { Hash, Moon, Sun } from 'lucide-react';
import { CountPill, SidebarMenu, SidebarRow } from '@/layers/shared/ui';
import {
  directedCountCap,
  directedCountLabel,
  type DirectedCountKind,
} from '@/layers/features/dashboard-sidebar/ui/rooms/directed-count-label';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';

/**
 * The visible panel width the redesign builds to (design-system §Sidebar).
 *
 * Spelled here rather than as `w-68` so the number a reviewer measures on this
 * page is the number the guide names, and a browser test can assert it.
 */
export const PANEL_WIDTH = 272;

/**
 * The count pill the `directed` tier draws, and the only mark either unread
 * tier is allowed (design-decisions §18).
 *
 * The cockpit's own `CountPill`, not a stand-in — the point of the page is to
 * show what the sidebar draws, so an invented badge here would be showing
 * nothing. Orange ink on its own wash, because orange means you: capped at `9+`
 * for mentions (the server stops counting at ten) and `99+` for a DM.
 *
 * **axe cannot judge it, and that is expected.** A one-digit label trips
 * axe-core's "content is too short to determine if it is actual text" heuristic,
 * so every one of these lands in the run's `incomplete` bucket rather than its
 * violations. The browser spec asserts that they are the ONLY thing in there, so
 * the hole stays exactly this size.
 *
 * @param count - How many things are addressed to you here.
 * @param kind - Mentions (a channel) or messages (a DM). Defaults to mentions.
 */
export function DirectedBadge({
  count,
  kind = 'mentions',
}: {
  count: number;
  kind?: DirectedCountKind;
}) {
  return (
    <CountPill count={count} cap={directedCountCap(kind)} label={directedCountLabel(count, kind)} />
  );
}

/**
 * The two unread tiers, on the sidebar's own row, in one place.
 *
 * Two tiers and no more (design-decisions §18): something happened here is a
 * **bold label and nothing else**, and something is addressed to you adds a
 * numbered count pill in the orange `you` tone. The tier that draws nothing is the one that keeps
 * getting a dot added back, which is why it is showcased beside the one that
 * does draw something rather than left to a table in a document.
 */
export function SidebarUnreadTiersShowcase() {
  return (
    <PlaygroundSection
      title="Sidebar Unread Tiers"
      description="Two tiers, and no third weight. Activity — something happened here — is a bold label with no badge and no dot. Directed at you — a DM, or an @mention anywhere — adds an orange count pill: mentions cap at 9+, a DM's messages at 99+. Muting kills both, except that an @mention keeps its count."
    >
      <ShowcaseLabel>Activity, directed, read, muted</ShowcaseLabel>
      <div className="border-border/50 bg-muted/30 rounded-lg border border-dashed p-4">
        <nav
          aria-label="Sidebar (unread tiers)"
          style={{ width: PANEL_WIDTH }}
          className="bg-sidebar text-sidebar-foreground rounded-lg p-2"
        >
          <SidebarMenu className="gap-0">
            <SidebarRow
              glyph={<Hash aria-hidden className="text-sidebar-foreground/60 size-3.5" />}
              title="releases"
              emphasized
              dataSlot="sidebar-unread-activity"
            />
            <SidebarRow
              glyph={<Hash aria-hidden className="text-sidebar-foreground/60 size-3.5" />}
              title="design"
              emphasized
              trailing={<DirectedBadge count={2} />}
              dataSlot="sidebar-unread-directed"
            />
            <SidebarRow
              glyph={<Hash aria-hidden className="text-sidebar-foreground/60 size-3.5" />}
              title="noise"
              dataSlot="sidebar-unread-none"
            />
            <SidebarRow
              glyph={<Hash aria-hidden className="text-sidebar-foreground/60 size-3.5" />}
              title="support"
              emphasized
              trailing={<DirectedBadge count={14} />}
              dataSlot="sidebar-unread-directed-capped"
            />
            <SidebarRow
              glyph={<Hash aria-hidden className="text-sidebar-foreground/60 size-3.5" />}
              title="Mara Quill"
              emphasized
              trailing={<DirectedBadge count={128} kind="messages" />}
              dataSlot="sidebar-unread-directed-dm"
            />
            <SidebarRow
              glyph={<Hash aria-hidden className="text-sidebar-foreground/60 size-3.5" />}
              title="archive"
              muted
              dataSlot="sidebar-unread-muted"
            />
            <SidebarRow
              glyph={<Hash aria-hidden className="text-sidebar-foreground/60 size-3.5" />}
              title="ops"
              muted
              trailing={<DirectedBadge count={1} />}
              dataSlot="sidebar-unread-muted-mention"
            />
          </SidebarMenu>
        </nav>
      </div>
      <p className="text-muted-foreground text-xs">
        Both themes matter here: switch the theme in the playground footer (
        <Sun className="inline size-3" /> / <Moon className="inline size-3" />) — the tint ramp
        moves away from the panel in the same direction in both, which is why{' '}
        <code className="text-foreground">--muted</code> is banned in this panel.
      </p>
    </PlaygroundSection>
  );
}
