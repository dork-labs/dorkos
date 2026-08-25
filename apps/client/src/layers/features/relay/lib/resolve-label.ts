import { TASK_SUBJECT_LABEL, TASK_SUBJECT_PREFIX } from '@dorkos/shared/relay-schemas';

/** Resolve a relay subject to a human-friendly label (client-side, no server calls). */
export function resolveSubjectLabelLocal(subject: string): string {
  if (subject === 'relay.system.console') return 'System Console';
  // Same words the server's `subject-resolver.ts` renders, from the same
  // constant, so the relay feed and an activity row can never call one object
  // by two names (DOR-1490).
  if (subject.startsWith(TASK_SUBJECT_PREFIX)) return TASK_SUBJECT_LABEL;
  if (subject.startsWith('relay.human.console.')) return 'Your Browser Session';
  if (subject.startsWith('relay.agent.')) {
    const id = subject.slice('relay.agent.'.length);
    return `Agent (${id.slice(0, 7)})`;
  }
  return subject;
}
