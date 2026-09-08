import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  initApprovalSubjectResolvers,
  resetApprovalSubjectResolvers,
  resolveApprovalSubject,
} from '../approval-subject.js';

const AGENT = { field: 'agentId', kind: 'agent' } as const;

afterEach(() => {
  resetApprovalSubjectResolvers();
});

describe('resolveApprovalSubject', () => {
  it('names the target from the registry that owns the id', async () => {
    initApprovalSubjectResolvers({ agent: (id) => (id === '01KX' ? 'Lab Scout' : undefined) });

    await expect(resolveApprovalSubject(AGENT, { agentId: '01KX' })).resolves.toEqual({
      kind: 'agent',
      label: 'Lab Scout',
      id: '01KX',
    });
  });

  it('awaits an async resolver', async () => {
    initApprovalSubjectResolvers({ agent: () => Promise.resolve('Lab Scout') });

    const subject = await resolveApprovalSubject(AGENT, { agentId: '01KX' });

    expect(subject?.label).toBe('Lab Scout');
  });

  it('reads a nested field the same way a display field is addressed', async () => {
    initApprovalSubjectResolvers({ agent: (id) => `agent ${id}` });

    const subject = await resolveApprovalSubject(
      { field: 'target.agentId', kind: 'agent' },
      { target: { agentId: '01KX' } }
    );

    expect(subject).toEqual({ kind: 'agent', label: 'agent 01KX', id: '01KX' });
  });

  // Every one of these has to leave the card showing the raw id, which is what
  // the summary already does when no subject comes back. A blank subject line
  // would be strictly worse than the defect this module fixes.
  describe('fails closed to the id, never to a blank', () => {
    it('resolves nothing when the action declares no subject', async () => {
      initApprovalSubjectResolvers({ agent: () => 'Lab Scout' });

      await expect(resolveApprovalSubject(undefined, { agentId: '01KX' })).resolves.toBeUndefined();
    });

    it('resolves nothing when no resolver is wired for the kind', async () => {
      initApprovalSubjectResolvers({ task: () => 'Nightly build' });

      await expect(resolveApprovalSubject(AGENT, { agentId: '01KX' })).resolves.toBeUndefined();
    });

    it('resolves nothing when nothing is wired at all', async () => {
      await expect(resolveApprovalSubject(AGENT, { agentId: '01KX' })).resolves.toBeUndefined();
    });

    it('resolves nothing when the registry does not hold the id', async () => {
      initApprovalSubjectResolvers({ agent: () => undefined });

      await expect(resolveApprovalSubject(AGENT, { agentId: 'gone' })).resolves.toBeUndefined();
    });

    it('resolves nothing, and does not throw, when the registry throws', async () => {
      initApprovalSubjectResolvers({
        agent: () => {
          throw new Error('database is down');
        },
      });

      await expect(resolveApprovalSubject(AGENT, { agentId: '01KX' })).resolves.toBeUndefined();
    });

    it('resolves nothing when an async resolver rejects', async () => {
      initApprovalSubjectResolvers({ agent: () => Promise.reject(new Error('down')) });

      await expect(resolveApprovalSubject(AGENT, { agentId: '01KX' })).resolves.toBeUndefined();
    });

    it.each([
      ['a number', { agentId: 42 }],
      ['an object', { agentId: { id: '01KX' } }],
      ['an empty string', { agentId: '' }],
      ['a missing field', {}],
      ['a non-object input', 'agentId=01KX'],
    ])('resolves nothing when the id is %s', async (_label, input) => {
      const resolver = vi.fn(() => 'Lab Scout');
      initApprovalSubjectResolvers({ agent: resolver });

      await expect(resolveApprovalSubject(AGENT, input)).resolves.toBeUndefined();
      // Not merely "returns undefined": a non-string id must never reach the
      // registry, or a caller could drive lookups with whatever it liked.
      expect(resolver).not.toHaveBeenCalled();
    });
  });

  describe('the label cannot be supplied by the caller', () => {
    it('ignores a name the caller put in its own arguments', async () => {
      initApprovalSubjectResolvers({ agent: () => 'Lab Scout' });

      const subject = await resolveApprovalSubject(AGENT, {
        agentId: '01KX',
        label: 'DorkBot',
        displayName: 'DorkBot',
        name: 'DorkBot',
      });

      expect(subject?.label).toBe('Lab Scout');
    });

    it('hands the registry the caller id and nothing else', async () => {
      const resolver = vi.fn(() => 'Lab Scout');
      initApprovalSubjectResolvers({ agent: resolver });

      await resolveApprovalSubject(AGENT, { agentId: '01KX', displayName: 'DorkBot' });

      expect(resolver).toHaveBeenCalledExactlyOnceWith('01KX');
    });

    it('caps a registry name that is long enough to crowd the card', async () => {
      initApprovalSubjectResolvers({ agent: () => 'N'.repeat(500) });

      const subject = await resolveApprovalSubject(AGENT, { agentId: '01KX' });

      expect(subject?.label.length).toBeLessThanOrEqual(60);
    });

    it('hides a token-shaped id rather than publishing it to every client', async () => {
      initApprovalSubjectResolvers({ agent: () => 'Lab Scout' });

      const subject = await resolveApprovalSubject(AGENT, { agentId: 'a'.repeat(40) });

      expect(subject?.id).not.toContain('a'.repeat(40));
    });
  });
});
