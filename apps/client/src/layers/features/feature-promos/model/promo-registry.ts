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
 *
 * `content.suggestion` is the one-line form the quiet state on home may speak
 * (team-room-home spec D5.3), and **a suggestion has to be earned by something
 * the person did** — not by a default they never chose. Two entries carry one,
 * and the two that do not are instructive:
 *
 * - **Remote Access** never speaks. It no longer qualifies unconditionally —
 *   `sidebar-simplification` D4 gave it a real trigger — but the quiet state is
 *   a different bar from a card: at priority 90 it would still be the sentence
 *   every browser-based install without a tunnel read under "All quiet." every
 *   morning, and "you have not set up remote access" is a standing fact rather
 *   than something the person just did.
 * - **Relay Adapters** no longer speaks either. Its condition reads as a
 *   qualification — Relay on, no adapter connected — but Relay ships ON and a
 *   fresh install has no adapters, so it describes the factory settings of a
 *   machine nobody has touched. Adding "and you have run something" would fix
 *   the honesty and create a different problem: at priority 80 it would sit
 *   permanently above Schedules in the one slot the quiet state has, and the
 *   suggestion this feature exists to make (the spec's own worked example)
 *   would only ever be reached by dismissing it first. Its cards stay on both
 *   sidebars, which is where "where should we ping you?" belongs.
 *
 * The two that speak both wait for something real: agents have actually been
 * run and nothing is scheduled yet, or the mesh has more than one agent in it.
 */
export const PROMO_REGISTRY: PromoDefinition[] = [
  {
    id: 'remote-access',
    placements: ['dashboard-sidebar'],
    priority: 90,
    // Not on the desktop app — offering somebody remote access to the machine
    // they are sitting at is not an offer — and not once remote access is set
    // up, whether or not the tunnel is currently running. Until
    // `sidebar-simplification` D4 this read `() => true`, which is the
    // definition of an ad: at priority 90 it was the card the sidebar showed
    // every morning forever, and there was no × to answer it with.
    shouldShow: (ctx) => !ctx.isDesktopApp && !ctx.remoteAccessConfigured,
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
    placements: ['agent-sidebar', 'dashboard-sidebar'],
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
    placements: ['agent-sidebar', 'dashboard-sidebar'],
    priority: 70,
    // Earned twice over: agents have been run here, and there is still nothing
    // on the books. Without the second half this offers to set up scheduling to
    // somebody who already schedules — and in the quiet state it would print
    // directly under a forward look naming the run they already have.
    shouldShow: (ctx) => ctx.isTasksEnabled && ctx.sessionCount > 0 && ctx.taskCount === 0,
    content: {
      icon: Moon,
      title: 'Run agents on a schedule',
      shortDescription: 'Set a schedule and come back to finished work',
      ctaLabel: 'Set up',
      suggestion: {
        question: 'Want your agents working without you at the keyboard?',
        action: 'Set up a schedule',
      },
    },
    action: { type: 'dialog', component: SchedulesDialog },
  },
  {
    id: 'agent-chat',
    placements: ['agent-sidebar'],
    priority: 60,
    shouldShow: (ctx) => ctx.isMeshEnabled && ctx.agentCount >= 2,
    content: {
      icon: MessagesSquare,
      title: 'Agent-to-agent conversations',
      shortDescription: 'Let your agents collaborate',
      ctaLabel: 'Learn more',
      // Opens differently from the Schedules line on purpose: two suggestions
      // that both start "Want your agents..." read as one template with the
      // nouns swapped.
      suggestion: {
        question: 'Two agents can split a job. Want to see how?',
        action: 'Show me',
      },
    },
    action: { type: 'dialog', component: AgentChatDialog },
  },
];
