/**
 * Shapes feature (DOR-355 §5) — the in-cockpit switcher UI + the apply mutation
 * that composes the reusable `entities/shapes` action with the agent-switch seam.
 *
 * @module features/shapes
 */
export { ShapeSwitcherDialog, type ShapeSwitcherDialogProps } from './ui/ShapeSwitcherDialog';
export { useApplyShape, type ApplyShapeVars } from './model/use-apply-shape';
export { useSwitchAgentCwd } from './model/use-switch-agent-cwd';
