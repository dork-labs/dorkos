import { Globe, MessageSquare, Moon, MessagesSquare } from 'lucide-react';
import type { PromoDefinition } from './promo-types';
import { TunnelDialog } from '@/layers/features/settings';
import { RelayAdaptersDialog } from '../ui/dialogs/RelayAdaptersDialog';
import { SchedulesDialog } from '../ui/dialogs/SchedulesDialog';
import { AgentChatDialog } from '../ui/dialogs/AgentChatDialog';

/**
 * Central registry of all feature promos.
 * Adding a new promo is: add an entry here + (optionally) write a dialog content component.
 *
 * Priority ordering rationale:
 * - Remote Access (90): drives daily engagement
 * - Relay Adapters (80): drives retention through notifications
 * - Schedules (70): unlocks autonomous operation
 * - Agent Chat (60): advanced/power-user territory
 */
export const PROMO_REGISTRY: PromoDefinition[] = [
  {
    id: 'remote-access',
    placements: ['dashboard-main', 'dashboard-sidebar'],
    priority: 90,
    shouldShow: () => true,
    content: {
      icon: Globe,
      title: 'Use DorkOS on the go',
      shortDescription: 'Access your agents from anywhere',
      ctaLabel: 'Learn more',
    },
    action: { type: 'open-dialog', component: TunnelDialog },
  },
  {
    id: 'relay-adapters',
    placements: ['dashboard-main', 'agent-sidebar', 'dashboard-sidebar'],
    priority: 80,
    shouldShow: (ctx) =>
      ctx.isRelayEnabled && !ctx.hasAdapter('slack') && !ctx.hasAdapter('telegram'),
    content: {
      icon: MessageSquare,
      title: 'Connect to Slack & Telegram',
      shortDescription: 'Get notifications where you already are',
      ctaLabel: 'Learn more',
    },
    action: { type: 'dialog', component: RelayAdaptersDialog },
  },
  {
    id: 'schedules',
    placements: ['dashboard-main', 'agent-sidebar', 'dashboard-sidebar'],
    priority: 70,
    shouldShow: (ctx) => ctx.isTasksEnabled && ctx.sessionCount > 0,
    content: {
      icon: Moon,
      title: 'Run agents while you sleep',
      shortDescription: 'Set schedules and wake up to results',
      ctaLabel: 'Set up',
    },
    action: { type: 'dialog', component: SchedulesDialog },
  },
  {
    id: 'agent-chat',
    placements: ['dashboard-main', 'agent-sidebar'],
    priority: 60,
    shouldShow: (ctx) => ctx.isMeshEnabled && ctx.agentCount >= 2,
    content: {
      icon: MessagesSquare,
      title: 'Agent-to-agent conversations',
      shortDescription: 'Let your agents collaborate',
      ctaLabel: 'Learn more',
    },
    action: { type: 'dialog', component: AgentChatDialog },
  },
];
