import { useState, useCallback } from 'react';
import { CelebrationOverlay } from '@/layers/features/chat/ui/CelebrationOverlay';
import { DragHandle } from '@/layers/features/chat/ui/DragHandle';
import type { CelebrationEvent } from '@/layers/shared/lib';
import { PlaygroundSection } from '../PlaygroundSection';

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wider">
      {children}
    </div>
  );
}

/** Miscellaneous component showcases: CelebrationOverlay, DragHandle. */
export function MiscShowcases() {
  const [celebration, setCelebration] = useState<CelebrationEvent | null>(null);
  const [collapsed, setCollapsed] = useState(true);

  const fireCelebration = useCallback(() => {
    setCelebration({
      level: 'major',
      taskId: 'demo-task',
      timestamp: Date.now(),
    });
  }, []);

  return (
    <>
      <PlaygroundSection
        title="CelebrationOverlay"
        description="Confetti celebration triggered by completing all tasks."
      >
        <button
          type="button"
          onClick={fireCelebration}
          className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-4 py-2 text-sm font-medium transition-colors"
        >
          Fire confetti
        </button>
        <CelebrationOverlay
          celebration={celebration}
          onComplete={() => setCelebration(null)}
        />
      </PlaygroundSection>

      <PlaygroundSection
        title="DragHandle"
        description="Pill-shaped toggle for collapsing/expanding sections."
      >
        <Label>{collapsed ? 'Collapsed' : 'Expanded'}</Label>
        <DragHandle
          collapsed={collapsed}
          onToggle={() => setCollapsed((c) => !c)}
        />
      </PlaygroundSection>
    </>
  );
}
