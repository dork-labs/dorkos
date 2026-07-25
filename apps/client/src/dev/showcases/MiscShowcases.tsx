import { useState, useCallback } from 'react';
import { CelebrationOverlay } from '@/layers/features/chat/ui/CelebrationOverlay';
import { Button } from '@/layers/shared/ui';
import type { CelebrationEvent } from '@/layers/shared/lib';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** Miscellaneous component showcases: CelebrationOverlay. */
export function MiscShowcases() {
  const [celebration, setCelebration] = useState<CelebrationEvent | null>(null);

  const fireCelebration = useCallback(() => {
    setCelebration({
      level: 'major',
      taskId: 'demo-task',
      timestamp: Date.now(),
    });
  }, []);

  return (
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
  );
}
