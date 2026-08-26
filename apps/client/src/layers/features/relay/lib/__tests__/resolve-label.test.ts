import { describe, it, expect } from 'vitest';
import { TASK_SUBJECT_LABEL } from '@dorkos/shared/relay-schemas';
import { resolveSubjectLabelLocal } from '../resolve-label';

/**
 * The client half of the twin-resolver guard (DOR-1490).
 *
 * Two resolvers render a `relay.system.tasks.*` subject: this one, and the
 * server's `services/relay/subject-resolver.ts`. They cannot import each other,
 * so what keeps them honest is the shared constant both read. The server's own
 * suite asserts the same equality from its side; between them, re-hardcoding
 * either copy turns one of the two red.
 */
describe('resolveSubjectLabelLocal', () => {
  it('names a scheduler subject with the shared label, not a local copy of it', () => {
    expect(resolveSubjectLabelLocal('relay.system.tasks.sched-1')).toBe(TASK_SUBJECT_LABEL);
  });

  it('resolves the other system subjects it owns', () => {
    expect(resolveSubjectLabelLocal('relay.system.console')).toBe('System Console');
    expect(resolveSubjectLabelLocal('relay.human.console.abc')).toBe('Your Browser Session');
  });

  it('shortens an agent subject to a readable id', () => {
    expect(resolveSubjectLabelLocal('relay.agent.abcdefghijkl')).toBe('Agent (abcdefg)');
  });

  it('hands back anything it does not recognise, rather than inventing a name', () => {
    expect(resolveSubjectLabelLocal('relay.something.else')).toBe('relay.something.else');
  });
});
