/**
 * Tier-1 generative-UI widget feature — renders catalog-constrained widget
 * documents (from `dorkos-ui` fences or the canvas) with host-owned shadcn
 * components.
 *
 * @module features/gen-ui
 */
export { WidgetRenderer } from './ui/WidgetRenderer';
export { WidgetFence } from './ui/WidgetFence';
export { WidgetErrorCard } from './ui/WidgetErrorCard';
export { WidgetSkeleton } from './ui/WidgetSkeleton';
export { UiActionChip } from './ui/UiActionChip';
export { parseWidget, validateWidgetDocument, type ParseWidgetResult } from './model/parse-widget';
export { parseUiActionMessage, type ParsedUiAction } from './lib/ui-action-parse';
