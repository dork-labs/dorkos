import type { Project } from './types';

export const projects: Project[] = [
  {
    id: 'chat-interface',
    title: 'Chat Interface',
    description:
      'Rich markdown, streaming responses, and syntax highlighting. Claude Code in a real browser UI.',
  },
  {
    id: 'tool-approval',
    title: 'Tool Approval',
    description:
      'Review and approve every tool call before it executes. Full control over what Claude does on your machine.',
  },
  {
    id: 'session-management',
    title: 'Session Management',
    description:
      'Browse, resume, and sync sessions across devices. Works with CLI-started sessions. One source of truth.',
  },
  {
    id: 'slash-commands',
    title: 'Slash Commands',
    description:
      'Discover and run commands from .claude/commands/ with a searchable palette. Your workflows, surfaced.',
  },
];
