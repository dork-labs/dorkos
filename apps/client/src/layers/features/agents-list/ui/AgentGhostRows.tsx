import { motion } from 'motion/react';
import { ScanSearch } from 'lucide-react';
import { Button } from '@/layers/shared/ui/button';
import { useImportProjectsStore } from '@/layers/shared/model';

const ghostContainerVariants = {
  animate: {
    transition: { staggerChildren: 0.1 },
  },
} as const;

const ghostRowVariants = {
  initial: { opacity: 0 },
  animate: { opacity: 0.2, transition: { duration: 0.3 } },
} as const;

/** A single skeleton row mimicking the two-line agent card layout. */
function GhostRow() {
  return (
    <motion.div variants={ghostRowVariants} className="rounded-xl border border-dashed px-4 py-3">
      {/* Line 1: dot placeholder + name bar + badge bar + time bar */}
      <div className="mb-2 flex items-center gap-2">
        <div className="bg-muted size-3 rounded-full" />
        <div className="bg-muted h-3 w-32 rounded" />
        <div className="bg-muted h-3 w-16 rounded" />
        <div className="bg-muted ml-auto h-3 w-10 rounded" />
      </div>
      {/* Line 2: path bar + session count bar */}
      <div className="flex items-center gap-2">
        <div className="bg-muted h-2.5 w-48 rounded" />
        <div className="bg-muted h-2.5 w-20 rounded" />
      </div>
    </motion.div>
  );
}

/** Mode A empty state — three dashed ghost rows with a centered CTA overlay. */
export function AgentGhostRows() {
  const openImport = useImportProjectsStore((s) => s.open);

  return (
    <div className="relative w-full max-w-2xl px-4">
      {/* Ghost rows */}
      <motion.div
        variants={ghostContainerVariants}
        initial="initial"
        animate="animate"
        className="space-y-3"
      >
        <GhostRow />
        <GhostRow />
        <GhostRow />
      </motion.div>

      {/* Centered overlay CTA */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
        <p className="text-lg font-semibold">Bring in existing projects</p>
        <Button size="sm" className="gap-1.5" onClick={openImport}>
          <ScanSearch className="size-3.5" />
          Search for Projects
        </Button>
      </div>
    </div>
  );
}
