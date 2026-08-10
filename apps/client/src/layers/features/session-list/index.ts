/**
 * Session list feature — sidebar for session management and directory selection.
 *
 * @module features/session-list
 */
export { EmbedSidebar } from './ui/EmbedSidebar';
export { SessionsView } from './ui/SessionsView';
export { TasksView } from './ui/TasksView';
// The desktop app's native updater, read by the sidebar footer strip's update
// pill (BC-44). It stays in this slice because the Electron bridge it wraps is
// this slice's, and the strip is a consumer like any other.
export { useDesktopUpdater } from './model/use-desktop-updater';

// --- Contribution data ---
export { SIDEBAR_FOOTER_BUTTONS } from './model/sidebar-contributions';
