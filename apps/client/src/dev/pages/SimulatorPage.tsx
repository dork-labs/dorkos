import { useState, useCallback } from 'react';
import { SCENARIOS, useSimulator } from '../simulator';
import { SimulatorControls } from '../simulator/SimulatorControls';
import { SimulatorChatPanel } from '../simulator/SimulatorChatPanel';
import type { TextEffectMode, TextEffectConfig } from '@/layers/shared/lib';

/** Dev playground page for simulating chat message streaming with scripted scenarios. */
export function SimulatorPage() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id);
  const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? null;
  const sim = useSimulator(scenario);

  const [textEffectMode, setTextEffectMode] = useState<TextEffectMode>('blur-in');
  const [animationEnabled, setAnimationEnabled] = useState(true);

  const textEffect: TextEffectConfig = animationEnabled
    ? { mode: textEffectMode, duration: 150, easing: 'ease-out', sep: 'word' }
    : { mode: 'none' };

  const handleScenarioChange = useCallback((id: string) => {
    setScenarioId(id);
  }, []);

  return (
    <div className="flex h-[calc(100dvh-2.25rem)] flex-col">
      <SimulatorControls
        scenarios={SCENARIOS}
        selectedScenarioId={scenarioId}
        onScenarioChange={handleScenarioChange}
        sim={sim}
        textEffectMode={textEffectMode}
        onTextEffectModeChange={setTextEffectMode}
        animationEnabled={animationEnabled}
        onAnimationEnabledChange={setAnimationEnabled}
      />
      <div className="min-h-0 flex-1">
        <SimulatorChatPanel sim={sim} textEffect={textEffect} />
      </div>
    </div>
  );
}
