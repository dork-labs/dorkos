import { useState } from 'react';
import { Hash } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { BOOT_CACHE_KEY_PREFIX, clearBootCache } from '@/layers/shared/lib';
import { Button, SectionHeader, SidebarRow, Skeleton } from '@/layers/shared/ui';
import { SidebarSkeleton } from '@/layers/features/dashboard-sidebar';
import {
  REVEAL_CONTAINER,
  REVEAL_ZONE,
  revealTransition,
} from '@/layers/features/dashboard-sidebar';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** The real panel width, so the bones are judged at the size they ship at. */
function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-sidebar text-sidebar-foreground w-[272px] rounded-lg px-2 py-3">
      {children}
    </div>
  );
}

/** What the skeleton is standing in for: three headers and eight real rows. */
function SettledPanel() {
  return (
    <div className="flex flex-col gap-1">
      <SectionHeader label="Heads up" />
      <SidebarRow glyph={<Hash className="size-[18px]" />} title="#team" />
      <SidebarRow glyph={<Hash className="size-[18px]" />} title="#releases" />
      <SectionHeader label="Today" />
      <SidebarRow who="Scout" title="fix the flake" />
      <SidebarRow who="Ana" title="rewrite the importer" />
      <SidebarRow who="Bo" title="chase the 500s" />
      <SectionHeader label="Agents" />
      <SidebarRow who="Scout" title="Scout" />
      <SidebarRow who="Ana" title="Ana" />
      <SidebarRow who="Bo" title="Bo" />
    </div>
  );
}

/**
 * How the sidebar comes up: cold, warm, and the one reveal between them.
 *
 * Spec `sidebar-simplification` D6. Everything here is the real thing — the
 * shipped `SidebarSkeleton`, the shipped reveal constants — so a geometry
 * regression shows up as the two panels disagreeing rather than as a lookalike
 * quietly staying right.
 */
export function SidebarBootShowcases() {
  const [revealed, setRevealed] = useState(false);
  const reducedMotion = useReducedMotion();

  return (
    <PlaygroundSection
      title="Sidebar Boot"
      description="Cold or warm, and exactly one change of state between them."
    >
      <ShowcaseLabel>
        Cold and warm, side by side — the bones sit on the geometry the rows land on
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-wrap gap-6">
          <div className="space-y-2">
            <p className="text-muted-foreground text-2xs">Cold — nothing known yet</p>
            <Panel>
              <SidebarSkeleton />
            </Panel>
          </div>
          <div className="space-y-2">
            <p className="text-muted-foreground text-2xs">
              Warm — the final shape, in the first frame
            </p>
            <Panel>
              <SettledPanel />
            </Panel>
          </div>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        The one reveal — 160 ms, 4 px, zones staggered 30 ms, rows never
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="space-y-2">
          <p className="text-muted-foreground text-2xs">
            A cold boot changes state exactly once. Under a reduced-motion preference the same
            change is instant.
          </p>
          <Button size="sm" variant="outline" onClick={() => setRevealed((on) => !on)}>
            {revealed ? 'Back to cold' : 'Replay the reveal'}
          </Button>
          <Panel>
            <AnimatePresence mode="wait" initial={false}>
              {revealed ? (
                <motion.div
                  key="zones"
                  className="flex flex-col gap-1"
                  variants={REVEAL_CONTAINER}
                  initial="hidden"
                  animate="shown"
                >
                  <motion.div variants={REVEAL_ZONE} transition={revealTransition(reducedMotion)}>
                    <SettledPanel />
                  </motion.div>
                </motion.div>
              ) : (
                <motion.div key="skeleton" exit={{ opacity: 0 }}>
                  <SidebarSkeleton />
                </motion.div>
              )}
            </AnimatePresence>
          </Panel>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        The header, while the roster is still coming — a reserved pill, never “Your team”
      </ShowcaseLabel>
      <ShowcaseDemo>
        <Panel>
          <div className="flex items-center gap-1.5 px-2 py-1 text-[13px] font-semibold">
            <Skeleton className="my-[3px] h-3.5 w-24 rounded-sm" />
          </div>
        </Panel>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Local memory — what a warm boot paints from, and how to forget it
      </ShowcaseLabel>
      <ShowcaseDemo>
        <BootCacheControl />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** One kilobyte, for reporting the blob's size in something readable. */
const BYTES_PER_KB = 1024;

/**
 * What this browser remembers of the sidebar, and the button that forgets it.
 *
 * The size readout is the point as much as the button is: the allow-list is
 * supposed to keep this to tens of kilobytes even on a busy install, and the
 * only honest way to know is to look at the real blob on a real install.
 */
function BootCacheControl() {
  const [reading, setReading] = useState(() => measureBootCache());

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-2xs">
        The cockpit keeps its last answer for the panel’s handful of boot queries in this browser,
        so a reload paints the finished sidebar in the first frame. Clearing it makes the next load
        cold again.
      </p>
      <ul className="text-muted-foreground text-2xs space-y-1 font-mono">
        {reading.length === 0 && <li>Nothing remembered.</li>}
        {reading.map((entry) => (
          <li key={entry.key}>
            {entry.key} — {(entry.bytes / BYTES_PER_KB).toFixed(1)} KB, {entry.queries} queries
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          clearBootCache();
          setReading(measureBootCache());
        }}
      >
        Clear sidebar cache
      </Button>
    </div>
  );
}

/** Every remembered cockpit in this browser, with its serialized size. */
function measureBootCache(): { key: string; bytes: number; queries: number }[] {
  const entries: { key: string; bytes: number; queries: number }[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key === null || !key.startsWith(BOOT_CACHE_KEY_PREFIX)) continue;
    const raw = window.localStorage.getItem(key) ?? '';
    let queries = 0;
    try {
      queries =
        (JSON.parse(raw) as { clientState?: { queries?: unknown[] } }).clientState?.queries
          ?.length ?? 0;
    } catch {
      // Unparseable cache entry — the 0 default stands.
    }
    entries.push({ key, bytes: new Blob([raw]).size, queries });
  }
  return entries;
}
