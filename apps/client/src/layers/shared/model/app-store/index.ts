/**
 * Global app store — Zustand store with canvas, panel, and preference slices.
 *
 * @module shared/model/app-store
 */
export { useAppStore } from './app-store';
export type { AppState, CoreSlice } from './app-store-types';
export type { ContextFile, RecentCwd } from './app-store-helpers';
export type { PanelsSlice } from './app-store-panels';
export type { PreferencesSlice } from './app-store-preferences';
export type { CanvasSlice } from './app-store-canvas';
export type { RightPanelSlice } from './app-store-right-panel';
