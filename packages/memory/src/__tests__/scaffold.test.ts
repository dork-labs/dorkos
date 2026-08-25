import { describe, expect, it } from 'vitest';

import { formatMemoryCap } from '@dorkos/shared/convention-files';
import { defaultMemoryTemplate } from '../scaffold.js';

describe('defaultMemoryTemplate', () => {
  const template = defaultMemoryTemplate();

  it('carries the visibility rule verbatim', () => {
    // The one paragraph nobody may paraphrase: it is the only warning an
    // operator gets before writing something into a file that can surface in a
    // room full of other people. Reflowing is allowed; changing the words is not,
    // so the assertion is on the sentences with their line breaks folded away.
    const flattened = template.replace(/\s+/g, ' ');

    expect(flattened).toContain(
      'Anything in this file can come up in ANY conversation this agent joins, ' +
        'including group channels and bridged rooms with other people in them.'
    );
    expect(flattened).toContain(
      'Never store secrets, credentials, or anything you would not say in a shared room.'
    );
  });

  it('says what the file is, in a sentence a non-developer can read', () => {
    expect(template).toContain('short notes it keeps between conversations');
  });

  it('states the cap, using the real constant', () => {
    // Hard-coding 8,000 here would let the prose and the enforcement drift apart
    // silently — the file would promise one limit and the writer enforce another.
    // Through `formatMemoryCap`, so this also pins that every surface a person
    // reads spells the number the SAME way.
    expect(template).toContain(`up to ${formatMemoryCap()} characters`);
    expect(template).toContain('up to 8,000 characters');
  });

  it('explains the provenance convention and that the agent does not choose it', () => {
    expect(template).toContain('(noted in #general, 2026-01-31)');
    expect(template).toContain('does not choose that part');
  });

  it('never tells anyone there is no memory yet', () => {
    // A new file is empty. Saying so invites an agent to treat a file it could
    // not read as one it may overwrite, which is the failure the three-way read
    // exists to prevent — so the phrasing must not exist anywhere, template
    // included.
    expect(template.toLowerCase()).not.toContain('no memory');
    expect(template.toLowerCase()).not.toContain('no notes');
    expect(template.toLowerCase()).not.toContain('nothing here yet');
  });

  it('leaves room for the first note under a heading', () => {
    expect(template.trimEnd().endsWith('## Notes')).toBe(true);
  });
});
