/** Resolve a relay subject to a human-friendly label (client-side, no server calls). */
export function resolveSubjectLabelLocal(subject: string): string {
  if (subject === 'relay.system.console') return 'System Console';
  if (subject.startsWith('relay.system.pulse.')) return 'Pulse Scheduler';
  if (subject.startsWith('relay.human.console.')) return 'Your Browser Session';
  if (subject.startsWith('relay.agent.')) {
    const id = subject.slice('relay.agent.'.length);
    return `Agent (${id.slice(0, 7)})`;
  }
  return subject;
}
