import { useState, useCallback } from 'react';
import { CelebrationOverlay } from '@/layers/features/chat/ui/CelebrationOverlay';
import { DragHandle } from '@/layers/features/chat/ui/DragHandle';
import { Button } from '@/layers/shared/ui';
import type { CelebrationEvent } from '@/layers/shared/lib';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

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
        <ShowcaseDemo>
          <Button variant="outline" onClick={fireCelebration}>
            Fire confetti
          </Button>
        </ShowcaseDemo>
        <CelebrationOverlay celebration={celebration} onComplete={() => setCelebration(null)} />
      </PlaygroundSection>

      <PlaygroundSection
        title="DragHandle"
        description="Pill-shaped toggle for collapsing/expanding sections."
      >
        <ShowcaseLabel>{collapsed ? 'Collapsed' : 'Expanded'}</ShowcaseLabel>
        <ShowcaseDemo>
          <DragHandle collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
