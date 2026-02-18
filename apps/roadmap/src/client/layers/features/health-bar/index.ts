/**
 * Health bar feature — project stats bar and view-mode tab switcher.
 *
 * @module features/health-bar
 */
export { HealthBar } from './ui/HealthBar';
export { ViewTabs } from './ui/ViewTabs';
export { ThemeToggle } from './ui/ThemeToggle';
export { useHealthStats, computeHealthStats } from './model/use-health-stats';
export type { HealthStats } from './model/use-health-stats';
