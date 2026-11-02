/**
 * The ⌘K pill: "Find a conversation…", under the header block (BC-46).
 *
 * It **opens the palette the rest of the app already opens** — the same
 * `globalPaletteOpen` flag the `⌘K` chord itself flips — rather than forking a
 * second search. A pill that led somewhere else would be a second command
 * surface with half the results, which is the same defect as the scattered
 * create menus one row above it.
 *
 * "Find a conversation" and not "Search": the list above lists places and no
 * sessions, so this pill is how a conversation that is not a place — an
 * agent's work chat above all — is found by name and recency. ⌘K finds agents,
 * rooms and actions too, and message-content search is a separate surface it
 * hands off to (§15).
 *
 * @module features/dashboard-sidebar/ui/SidebarSearchPill
 */
import { Search } from 'lucide-react';
import { cn, formatShortcutKey, SHORTCUTS } from '@/layers/shared/lib';
import { useAppStore, useIsMobile } from '@/layers/shared/model';
import { Kbd, TOUCH_TARGET_MIN_H } from '@/layers/shared/ui';

/** Props for {@link SidebarSearchPill}. */
export interface SidebarSearchPillProps {
  /** Layout classes from the header: on a phone the pill takes the row's free width. */
  className?: string;
}

/**
 * The command-palette pill.
 *
 * A `<button>` rather than a text field: nothing is typed here, and a field
 * that steals focus to hand it straight to a dialog is the kind of small lie
 * this panel does not tell.
 *
 * Its ring is the shared `focus-ring`, 2px out, like every standalone control
 * in the panel (Phase 4 S5).
 */
export function SidebarSearchPill({ className }: SidebarSearchPillProps = {}) {
  const setGlobalPaletteOpen = useAppStore((s) => s.setGlobalPaletteOpen);
  const isMobile = useIsMobile();

  return (
    <button
      type="button"
      data-testid="sidebar-search-pill"
      onClick={() => setGlobalPaletteOpen(true)}
      className={cn(
        'bg-sidebar-accent/40 text-sidebar-foreground/70 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground focus-ring text-control flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors duration-(--dur-fast)',
        // 33px measured at 390×844, under the 40px bar (P4 AC-4).
        isMobile && TOUCH_TARGET_MIN_H,
        className
      )}
    >
      <Search className="size-(--size-icon-sm) shrink-0" />
      <span className="truncate">Find a conversation…</span>
      {/* The shared `Kbd` is filled with `--muted` by default, the one
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
