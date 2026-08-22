import { useState } from 'react';
import { Hash } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Button, SectionHeader, SidebarMenu, SidebarRow } from '@/layers/shared/ui';
import {
  ARRIVE_FROM,
  ARRIVE_TO,
  DRAG_LIFT_SCALE,
  LEAVE_TO,
  arriveTransition,
  foldTransition,
  leaveTransition,
  sectionLayoutKey,
} from '@/layers/features/dashboard-sidebar';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** The real panel width, so every motion here is judged at the size it ships at. */
function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-sidebar text-sidebar-foreground w-[272px] rounded-lg px-2 py-3">
      {children}
    </div>
  );
}

/** One demo's rows, as the model would spell them. */
interface DemoRow {
  key: string;
  title: string;
}

const TODAY: DemoRow[] = [
  { key: 'a', title: 'Scout › fix the flake' },
  { key: 'b', title: 'Ana › rewrite the importer' },
  { key: 'c', title: 'Bo › chase the 500s' },
];

/** The row a press adds, so an arrival is always the same arrival. */
const NEWCOMER: DemoRow = { key: 'new', title: 'Rae › the build went red' };

/** Fold with a count: a height spring, a chevron turn, and a quiet roll-up. */
function FoldDemo() {
  const [collapsed, setCollapsed] = useState(false);
  const reducedMotion = useReducedMotion();
  return (
    <Panel>
      <SectionHeader
        label="Channels"
        collapsed={collapsed}
        onToggle={() => setCollapsed((on) => !on)}
        controlsId="playground-fold-body"
        {...(collapsed ? { trailing: '3 · 1 unread' } : {})}
      />
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={foldTransition(reducedMotion)}
            className="overflow-hidden"
          >
            <SidebarMenu id="playground-fold-body">
              <SidebarRow glyph={<Hash className="size-[18px]" />} title="#team" />
              <SidebarRow glyph={<Hash className="size-[18px]" />} title="#releases" />
              <SidebarRow glyph={<Hash className="size-[18px]" />} title="#support" />
            </SidebarMenu>
          </motion.div>
        )}
      </AnimatePresence>
    </Panel>
  );
}

/** Arrive and settle: a row falls from the header and flashes the tint once. */
function ArriveDemo() {
  const [rows, setRows] = useState<DemoRow[]>(TODAY);
  const reducedMotion = useReducedMotion();
  const present = rows.some((row) => row.key === NEWCOMER.key);
  const layoutKey = sectionLayoutKey(rows);
  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="outline"
        onClick={() => setRows(present ? TODAY : [NEWCOMER, ...TODAY])}
      >
        {present ? 'Take it away' : 'Something needs you'}
      </Button>
      <Panel>
        <SectionHeader label="Today" />
        <SidebarMenu>
          <AnimatePresence initial={false}>
            {rows.map((row) => (
              <SidebarRow
                key={row.key}
                title={row.title}
                rowMotion={{
                  layout: true,
                  layoutDependency: layoutKey,
                  initial: row.key === NEWCOMER.key ? ARRIVE_FROM : false,
                  animate: ARRIVE_TO,
                  exit: LEAVE_TO,
                  transition:
                    row.key === NEWCOMER.key
                      ? arriveTransition(reducedMotion)
                      : leaveTransition(reducedMotion),
                  arrived: row.key === NEWCOMER.key,
                }}
              />
            ))}
          </AnimatePresence>
        </SidebarMenu>
      </Panel>
    </div>
  );
}

/** Move: the same rows, in a different order, sliding rather than popping. */
function MoveDemo() {
  const [rows, setRows] = useState<DemoRow[]>(TODAY);
  const layoutKey = sectionLayoutKey(rows);
  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="outline"
        onClick={() => setRows((current) => [...current.slice(1), current[0]!])}
      >
        Reorder — the hold just released
      </Button>
      <Panel>
        <SectionHeader label="Today" />
        <SidebarMenu>
          {rows.map((row) => (
            <SidebarRow
              key={row.key}
              title={row.title}
              rowMotion={{ layout: true, layoutDependency: layoutKey }}
            />
          ))}
        </SidebarMenu>
      </Panel>
    </div>
  );
}

/** Lift and ring: what a drag looks like on both ends of itself. */
function DragDemo() {
  return (
    <div className="flex flex-wrap items-start gap-6">
      <div className="space-y-2">
        <p className="text-muted-foreground text-[11px]">
          The overlay under the cursor — lifted {Math.round((DRAG_LIFT_SCALE - 1) * 100)}%, with the
          floating shadow
        </p>
        <div className="bg-sidebar w-[272px] rounded-lg p-6">
          <div className="bg-sidebar border-sidebar-border text-sidebar-foreground shadow-floating inline-flex scale-[1.02] items-center rounded-md border px-2.5 py-1.5 text-xs font-medium">
            #releases
          </div>
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-muted-foreground text-[11px]">
          The drop target — a 2px inset ring at 45%, never a background wash
        </p>
        <Panel>
          <SectionHeader label="Direct messages" />
          <SidebarMenu>
            <SidebarRow title="Scout" />
            <div className="sidebar-drop-ring rounded-md">
              <SidebarMenu>
                <SidebarRow title="Ana" />
              </SidebarMenu>
            </div>
          </SidebarMenu>
        </Panel>
      </div>
    </div>
  );
}

/**
 * The four continuity motions, each with a control that replays it.
 *
 * Spec `sidebar-simplification` D5. Everything here is the shipped component and
 * the shipped numbers — `SectionHeader`, `SidebarRow`, `foldTransition`,
 * `sectionLayoutKey` — so a retune shows up on this page rather than a lookalike
 * quietly staying right.
 */
export function SidebarMotionShowcases() {
  return (
    <PlaygroundSection
      title="Sidebar Motion"
      description="Motion explains a change you did not cause. Nothing loops, nothing decorates, and a reduced-motion preference turns all of it off."
    >
      <ShowcaseLabel>Fold with a count — a height spring, and the roll-up fades in</ShowcaseLabel>
      <ShowcaseDemo>
        <FoldDemo />
      </ShowcaseDemo>

      <ShowcaseLabel>
        Arrive, settle, no pulse — the row falls from the header and tints once
      </ShowcaseLabel>
      <ShowcaseDemo>
        <ArriveDemo />
      </ShowcaseDemo>

      <ShowcaseLabel>Move — a reorder slides, so the eye can follow one row</ShowcaseLabel>
      <ShowcaseDemo>
        <MoveDemo />
      </ShowcaseDemo>

      <ShowcaseLabel>Lift, ring, settle — both ends of a drag</ShowcaseLabel>
      <ShowcaseDemo>
        <DragDemo />
      </ShowcaseDemo>

      <ShowcaseLabel>Under a reduced-motion preference</ShowcaseLabel>
      <ShowcaseDemo>
        <p className="text-muted-foreground max-w-prose text-sm">
          Turn on “Reduce motion” in your system settings and replay any demo above. Every one of
          them becomes instant — not quicker, not gentler. The fold snaps, the row is simply there,
          the reorder is already done, and the arrival tint does not paint at all. Nothing on this
          page carries information that the panel does not also carry as words.
        </p>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
