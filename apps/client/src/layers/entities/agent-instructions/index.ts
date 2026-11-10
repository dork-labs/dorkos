/**
 * What agents are told (spec `context-viewer` phase 3): the template every
 * agent gets, one agent's preview, and the viewer both are read in.
 *
 * Read only. The server writes every block with the real prompt builders.
 *
 * @module entities/agent-instructions
 */
export {
  instructionsKeys,
  useInstructionsPreview,
  useInstructionsTemplate,
} from './model/use-agent-instructions';
export {
  InstructionsViewer,
  type InstructionsSelection,
  type InstructionsViewerProps,
} from './ui/InstructionsViewer';
export { TemplateText, templateParts } from './ui/TemplateText';
