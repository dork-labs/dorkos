import type { ComponentType } from 'react';
import { Blocks, CalendarClock, Smartphone } from 'lucide-react';
import { SlackIcon, TelegramLogo } from '@dorkos/icons/adapter-logos';

/** Id of something you can add to DorkOS, as the dock and the chat name it. */
export type DockAppId = 'skills' | 'schedule' | 'slack' | 'telegram' | 'phone';

/** One tile on the dock; its id drives the dock-to-message flight. */
export interface DockApp {
  id: DockAppId;
  label: string;
  /**
   * The `features.ts` slug this tile depicts.
   *
   * Load-bearing, not decoration: the home page animates each of these being
   * put to work, and the demo-claim gate says a page may only show a surface
   * that actually ships. `__tests__/home-copy.test.ts` resolves every slug
   * here against the feature catalog and fails if one is missing or is
   * anything other than `ga`. That is why Connections is absent — it is the
   * catalog's one `beta` entry, and its sign-in is brokered by a third party
   * that holds the credential in its own vault, which is also the one thing
   * that would make "It all happens on your computer." untrue.
   */
  feature: string;
  color: string;
  Icon: ComponentType<{ size?: number; className?: string }>;
}

/** What the dock carries. Every tile gets used by the conversation above it. */
export const DOCK: readonly DockApp[] = [
  { id: 'skills', label: 'Skills', feature: 'marketplace', color: '#d5a439', Icon: Blocks },
  {
    id: 'schedule',
    label: 'Schedule',
    feature: 'task-scheduler',
    color: '#4cc38a',
    Icon: CalendarClock,
  },
  { id: 'slack', label: 'Slack', feature: 'slack-adapter', color: '#f5f0e6', Icon: SlackIcon },
  {
    id: 'telegram',
    label: 'Telegram',
    feature: 'telegram-adapter',
    color: '#6fa8dc',
    Icon: TelegramLogo,
  },
  { id: 'phone', label: 'Phone', feature: 'mobile', color: '#d97757', Icon: Smartphone },
];

/** Shared layout id that carries a tile from its dock slot into a message. */
export function dockLayoutId(id: DockAppId): string {
  return `dock-${id}`;
}

/** Look up a dock tile by id. */
export function findDockApp(id: string): DockApp | undefined {
  return DOCK.find((entry) => entry.id === id);
}
