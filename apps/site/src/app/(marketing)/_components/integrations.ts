import type { ComponentType } from 'react';
import { Calendar, FileText, GitBranch, Mail } from 'lucide-react';
import { SlackIcon } from '@dorkos/icons/adapter-logos';

/** Id of an app the chat can put to work. */
export type IntegrationId = 'email' | 'calendar' | 'git' | 'docs' | 'slack';

/** An app on the dock; its id drives the dock-to-message flight. */
export interface Integration {
  id: IntegrationId;
  label: string;
  color: string;
  Icon: ComponentType<{ size?: number; className?: string }>;
}

/** The connectable apps shown on the dock. Every one of them gets used. */
export const INTEGRATIONS: readonly Integration[] = [
  { id: 'email', label: 'Email', color: '#6fa8dc', Icon: Mail },
  { id: 'calendar', label: 'Calendar', color: '#4cc38a', Icon: Calendar },
  { id: 'git', label: 'Git', color: '#d97757', Icon: GitBranch },
  { id: 'docs', label: 'Docs', color: '#d5a439', Icon: FileText },
  { id: 'slack', label: 'Slack', color: '#f5f0e6', Icon: SlackIcon },
];

/** Shared layout id that carries an app icon from its dock slot into a message. */
export function integrationLayoutId(id: IntegrationId): string {
  return `int-${id}`;
}

/** Look up an app by id. */
export function findIntegration(id: string): Integration | undefined {
  return INTEGRATIONS.find((entry) => entry.id === id);
}
