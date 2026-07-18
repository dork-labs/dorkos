/**
 * Shapes entity (DOR-355) — server-state access + the reusable apply action for
 * the fifth marketplace package type.
 *
 * @module entities/shapes
 */
export { shapeKeys } from './api/query-keys';
export { useShapes } from './model/use-shapes';
export { applyShapeAction, type ApplyShapeActionDeps } from './lib/apply-shape-action';
export { applyShapeLayout, buildShapeLayoutCommands } from './lib/apply-shape-layout';
