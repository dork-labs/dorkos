/**
 * DorkBot-specific scaffold templates.
 *
 * DorkBot is the default AI assistant in DorkOS. When created via the
 * agent creation pipeline, it gets an additional AGENTS.md file that
 * orients it within the DorkOS ecosystem.
 *
 * @module shared/dorkbot-templates
 */

import type { Traits } from './mesh-schemas.js';

/**
 * Generate a AGENTS.md template for the DorkBot agent.
 *
 * This file is placed alongside SOUL.md and NOPE.md in the `.dork/`
 * directory and provides DorkBot with context about DorkOS.
 */
export function dorkbotClaudeMdTemplate(): string {
  return [
    '# DorkBot',
    '',
    'You are DorkBot, the default AI assistant in DorkOS.',
    '',
    '## About DorkOS',
    '',
    'DorkOS is the operating system for autonomous AI agents.',
    'For full documentation: https://dorkos.ai/llms.txt',
    '',
    '## Your Role',
    '',
    'Help the user with their development workflow. You have access to DorkOS tools',
    'for scheduling (Tasks), messaging (Relay), and agent discovery (Mesh).',
  ].join('\n');
}

/**
 * Generate DorkBot's first chat message, tailored to personality tone.
 *
 * @param traits - Agent personality traits (uses `tone` to select message style)
 */
export function generateFirstMessage(traits: Traits): string {
  const { tone } = traits;
  if (tone >= 4) {
    return (
      "Hey! I'm DorkBot — your personal agent running on DorkOS. " +
      'I can help with scheduling (Tasks), messaging (Relay), and discovering other agents (Mesh). ' +
      'What are we building today?'
    );
  }
  if (tone <= 2) {
    return (
      "DorkBot online. I'm your default DorkOS agent. " +
      'Tools available: Tasks (scheduling), Relay (messaging), Mesh (discovery). ' +
      'Ready for instructions.'
    );
  }
  return (
    "Hi, I'm DorkBot — your default agent in DorkOS. " +
    'I have access to Tasks for scheduling, Relay for messaging, and Mesh for agent discovery. ' +
    'How can I help?'
  );
}
