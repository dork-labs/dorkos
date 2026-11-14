/**
 * What a Settings → Extensions row says at a glance (the chip, and whether the
 * switch is offered), and the order the rows sit in. Purpose: anything that
 * waits for a person shows "Needs your OK" with Review, never a switch that
 * would turn it on unseen; everything else is A–Z and stays put.
 */
import { describe, it, expect } from 'vitest';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import {
  extensionPurpose,
  extensionRowState,
  firstSentence,
  matchesExtensionSearch,
  sectionExtensions,
} from '../lib/extension-row-state';

function ext(id: string, overrides: Partial<ExtensionRecordPublic> = {}): ExtensionRecordPublic {
  return {
    id,
    status: 'active',
    scope: 'global',
    origin: 'user',
    bundleReady: true,
    hasServerEntry: false,
    hasDataProxy: false,
    approvedToRun: true,
    shadowedBy: null,
    ...overrides,
    manifest: { clientApiVersion: 2, id, name: id, version: '1.0.0', ...overrides.manifest },
  };
}

describe('extensionRowState', () => {
  it('shows nothing for a healthy extension, with its switch', () => {
    expect(extensionRowState(ext('a'))).toMatchObject({
      chip: null,
      needsYou: false,
      trailing: 'switch',
      isOn: true,
    });
  });

  it('says "Needs your OK" with Review for one waiting to be allowed', () => {
    expect(extensionRowState(ext('a', { approvedToRun: false }))).toMatchObject({
      need: 'needs-ok',
      chip: { label: 'Needs your OK', tone: 'warning' },
      needsYou: true,
      trailing: 'review',
    });
  });

  it('says "Needs your OK" first, with Review, for one whose screens are paused', () => {
    const state = extensionRowState(
      ext('a', { screensPaused: true, bundleReady: false, status: 'compile_error' })
    );
    expect(state).toMatchObject({ need: 'screens-paused', trailing: 'review', rank: 0 });
  });

  it('keeps an unapproved one that is off out of "Needs you", but never offers its switch', () => {
    expect(extensionRowState(ext('a', { approvedToRun: false, status: 'disabled' }))).toMatchObject(
      {
        need: null,
        needsYou: false,
        trailing: 'review',
      }
    );
  });

  it('never asks about one that comes with DorkOS', () => {
    expect(extensionRowState(ext('a', { origin: 'core', approvedToRun: false }))).toMatchObject({
      chip: null,
      trailing: 'switch',
    });
  });

  it('marks a broken one "Not working" and keeps its switch', () => {
    expect(
      extensionRowState(ext('a', { serverError: { code: 'server_crashed', message: '' } }))
    ).toMatchObject({ chip: { label: 'Not working', tone: 'error' }, trailing: 'switch' });
    // A rebuild failure while the last version runs is not broken.
    expect(
      extensionRowState(ext('a', { serverError: { code: 'compilation_failed', message: '' } })).chip
    ).toBeNull();
  });

  it('marks an invalid manifest "Can’t load", with Review', () => {
    expect(extensionRowState(ext('a', { status: 'invalid' }))).toMatchObject({
      chip: { label: 'Can’t load', tone: 'error' },
      trailing: 'review',
    });
  });

  it('marks one that needs a newer DorkOS with a quiet chip that does not count', () => {
    expect(extensionRowState(ext('a', { status: 'incompatible' }))).toMatchObject({
      chip: { label: 'Needs newer DorkOS', tone: 'neutral' },
      needsYou: false,
      isOn: false,
    });
  });
});

describe('sectionExtensions', () => {
  it('orders needs-you by need then name, the rest A–Z ignoring case, core apart', () => {
    const sections = sectionExtensions([
      ext('zed'),
      ext('Broken', { status: 'activate_error' }),
      ext('apple'),
      ext('waiting', { approvedToRun: false }),
      ext('Banana', { status: 'disabled' }),
      ext('paused', { screensPaused: true }),
      ext('core-z', { origin: 'core' }),
      ext('core-a', { origin: 'core' }),
    ]);
    const ids = (list: ExtensionRecordPublic[]) => list.map((item) => item.id);
    expect(ids(sections.needsYou)).toEqual(['paused', 'waiting', 'Broken']);
    expect(ids(sections.everythingElse)).toEqual(['apple', 'Banana', 'zed']);
    expect(ids(sections.core)).toEqual(['core-a', 'core-z']);
  });

  it('never moves a row when it is turned off', () => {
    const on = sectionExtensions([ext('a'), ext('b'), ext('c')]).everythingElse;
    const off = sectionExtensions([
      ext('a'),
      ext('b', { status: 'disabled' }),
      ext('c'),
    ]).everythingElse;
    expect(off.map((item) => item.id)).toEqual(on.map((item) => item.id));
  });
});

describe('the one line and the search', () => {
  it('prefers the summary, then the first sentence', () => {
    expect(
      extensionPurpose(
        ext('a', {
          manifest: {
            clientApiVersion: 2,
            id: 'a',
            name: 'a',
            version: '1.0.0',
            summary: 'Short.',
            description: 'Long. Longer.',
          },
        })
      )
    ).toBe('Short.');
    expect(
      extensionPurpose(
        ext('a', {
          manifest: {
            clientApiVersion: 2,
            id: 'a',
            name: 'a',
            version: '1.0.0',
            description: 'Long. Longer.',
          },
        })
      )
    ).toBe('Long.');
    expect(extensionPurpose(ext('a'))).toBe('');
  });

  it('does not end a sentence inside a version number', () => {
    expect(firstSentence('Needs v1.2 to run. Then more.')).toBe('Needs v1.2 to run.');
  });

  it('matches the name, the line, the author and a tool, ignoring case', () => {
    const mail = ext('mail', {
      manifest: {
        clientApiVersion: 2,
        id: 'mail',
        name: 'Mail',
        version: '1.0.0',
        author: 'Dork Labs',
        summary: 'Reads email.',
      },
      tools: [{ name: 'send_message', title: 'Send an email', tier: 'act', status: 'active' }],
    });
    for (const query of ['mail', 'READS', 'dork', 'send_message', 'send an', '  ']) {
      expect(matchesExtensionSearch(mail, query)).toBe(true);
    }
    expect(matchesExtensionSearch(mail, 'zebra')).toBe(false);
  });
});
