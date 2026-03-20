/**
 * Chat simulator — scripted scenario playback for visual QA of chat components.
 *
 * @module dev/simulator
 */
export type { SimStep, SimScenario } from './sim-types';
export { buildStreamingTextSteps } from './sim-helpers';
export { useSimulator, SPEED_PRESETS } from './use-simulator';
export type { SimulatorResult } from './use-simulator';

import {
  simpleConversation,
  toolCallSequence,
  toolApproval,
  questionPrompt,
  errorStates,
  multiToolChain,
  kitchenSink,
  deepRefactor,
  extendedConversation,
} from './scenarios';
import type { SimScenario } from './sim-types';

/** All available simulation scenarios. */
export const SCENARIOS: SimScenario[] = [
  simpleConversation,
  toolCallSequence,
  toolApproval,
  questionPrompt,
  errorStates,
  multiToolChain,
  kitchenSink,
  deepRefactor,
  extendedConversation,
];
