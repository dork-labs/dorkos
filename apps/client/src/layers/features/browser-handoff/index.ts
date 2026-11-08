/**
 * The card a person answers when an agent hands the Agent browser over (DOR-3218).
 * Its own slice so a chat can show it without loading the browser panel.
 *
 * @module features/browser-handoff
 */
export { BrowserHandoffCard } from './ui/BrowserHandoffCard';
export type { BrowserHandoffCardProps } from './ui/BrowserHandoffCard';
export { BrowserHandoffInboxItem } from './ui/BrowserHandoffInboxItem';
export { BrowserHandoffCardView } from './ui/BrowserHandoffCardView';
export type { BrowserHandoffCardViewProps } from './ui/BrowserHandoffCardView';
export { useBrowserHandoff, HANDED_BACK_MESSAGE } from './model/use-browser-handoff';
export type { HandoffStep } from './lib/handoff-step';
