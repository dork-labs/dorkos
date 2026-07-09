import type { LucideIcon } from 'lucide-react';
import { Terminal, AppWindow, Send, Webhook, Hash } from 'lucide-react';

export interface Integration {
  label: string;
  icon: LucideIcon;
  status: 'live' | 'coming-soon';
  /** Extra context shown after the label, e.g. "discovery" for Cursor. */
  qualifier?: string;
}

export interface Subsystem {
  id: string;
  benefit: string;
  name: string;
  description: string;
  status: 'available' | 'coming-soon';
  integrations?: Integration[];
}

export const subsystems: Subsystem[] = [
  {
    id: 'tasks',
    benefit: 'Hand off work; it runs on schedule',
    name: 'Tasks',
    description: "Tell your agents what to do and when to do it, and they'll handle the rest.",
    status: 'available',
  },
  {
    id: 'relay',
    benefit: 'Your agents reach you wherever you are',
    name: 'Relay',
    description: 'Telegram, Slack, webhooks — so your agents can reach you wherever you are.',
    status: 'available',
    integrations: [
      { label: 'Telegram', icon: Send, status: 'live' },
      { label: 'Webhooks', icon: Webhook, status: 'live' },
      { label: 'Slack', icon: Hash, status: 'live', qualifier: 'beta' },
    ],
  },
  {
    id: 'mesh',
    benefit: 'Your agents find each other',
    name: 'Mesh',
    description:
      "Your agents can discover each other, so you're not the one routing work between them.",
    status: 'available',
    integrations: [
      { label: 'Claude Code', icon: Terminal, status: 'live' },
      { label: 'Cursor', icon: AppWindow, status: 'live', qualifier: 'discovery' },
    ],
  },
  {
    id: 'console',
    benefit: 'See and steer every agent you run',
    name: 'Console',
    description: 'Chat with your agents, create new agents, manage schedules, and more.',
    status: 'available',
    integrations: [{ label: 'Claude Code', icon: Terminal, status: 'live' }],
  },
];
