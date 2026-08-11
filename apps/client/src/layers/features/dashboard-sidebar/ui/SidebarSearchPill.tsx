/**
 * The ⌘K pill: "Jump to anything…", under the header block (BC-46).
 *
 * It **opens the palette the rest of the app already opens** — the same
 * `globalPaletteOpen` flag the `⌘K` chord itself flips — rather than forking a
 * second search. A pill that led somewhere else would be a second command
 * surface with half the results, which is the same defect as the scattered
 * create menus one row above it.
 *
 * "Jump to anything" and not "Search": ⌘K finds things — agents, sessions,
 * rooms, actions — by name and recency, and message-content search is a
 * separate surface it hands off to (§15).
 *
 * @module features/dashboard-sidebar/ui/SidebarSearchPill
 */
import { Search } from 'lucide-react';
import { formatShortcutKey, SHORTCUTS } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { Kbd } from '@/layers/shared/ui';

/**
 * The command-palette pill.
 *
 * A `<button>` rather than a text field: nothing is typed here, and a field
 * that steals focus to hand it straight to a dialog is the kind of small lie
 * this panel does not tell.
 */
export function SidebarSearchPill() {
  const setGlobalPaletteOpen = useAppStore((s) => s.setGlobalPaletteOpen);

  return (
    <button
      type="button"
      data-testid="sidebar-search-pill"
      onClick={() => setGlobalPaletteOpen(true)}
      className="bg-sidebar-accent/40 text-sidebar-foreground/60 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground focus-visible:ring-sidebar-ring flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] outline-hidden transition-colors duration-150 focus-visible:ring-2"
    >
      <Search className="size-(--size-icon-sm) shrink-0" />
      <span className="truncate">Jump to anything…</span>
      {/* The shared `Kbd` is `bg-muted` by default, and `--muted` is the one
          token this panel may not use: it sits lighter than the sidebar in
          light mode and darker in dark mode, so the separation flips direction
          between themes (spec R1). The chip rides the `--sidebar-accent` ramp
          instead, like everything else in here. */}
      <Kbd className="bg-sidebar-accent text-sidebar-foreground/70 ml-auto shrink-0 border-transparent">
        {formatShortcutKey(SHORTCUTS.COMMAND_PALETTE)}
      </Kbd>
    </button>
  );
}
