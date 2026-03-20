import { useState, useCallback } from 'react';
import { SCENARIOS, useSimulator } from '../simulator';
import { SimulatorControls } from '../simulator/SimulatorControls';
import { SimulatorChatPanel } from '../simulator/SimulatorChatPanel';

/** Dev playground page for simulating chat message streaming with scripted scenarios. */
export function SimulatorPage() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id);
  const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? null;
  const sim = useSimulator(scenario);

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
      />
      <div className="min-h-0 flex-1">
        <SimulatorChatPanel sim={sim} />
      </div>
    </div>
  );
}
