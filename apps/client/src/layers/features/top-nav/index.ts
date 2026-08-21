/**
 * Parts of the top bar that stand on their own: the command palette trigger and
 * the system health dot.
 *
 * The bar that arranges them, and the per-route bars that fill it, live in
 * `widgets/one-bar` — they compose the inbox bell, which is a widget, so they
 * cannot live at this layer.
 *
 * @module features/top-nav
 */
export { CommandPaletteTrigger } from './ui/CommandPaletteTrigger';
export { SystemHealthDot } from './ui/SystemHealthDot';
export { useSystemHealth } from './model/use-system-health';
export type { SystemHealthState } from './model/use-system-health';
