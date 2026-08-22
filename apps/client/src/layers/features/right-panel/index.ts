/**
 * Right panel feature — shell-level resizable panel driven by the extension registry.
 *
 * @module features/right-panel
 */
export { RightPanelContainer } from './ui/RightPanelContainer';
export { RightPanelToggle } from './ui/RightPanelToggle';
// The shell every tab is mounted inside. Exported so a playground showcase can
// mount a panel the way the container does — a tab that only ever renders
// without it is a tab whose failure state nobody has looked at.
export { PanelErrorBoundary } from './ui/PanelErrorBoundary';
export {
  useRightPanelPersistence,
  useRightPanelLayoutPersistence,
} from './model/use-right-panel-persistence';
export { useRightPanelShortcut } from './model/use-right-panel-shortcut';
export { RIGHT_PANEL_GROUP_ID } from './model/use-right-panel-sizing';
