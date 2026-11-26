/**
 * What an agent reads of a dev-linked install (DOR-4978): no working folder,
 * in any field; a person reads it whole.
 */
import { describe, it, expect } from 'vitest';

import type { CapabilityHandlerContext } from '../../../core/capabilities/index.js';
import { heldBackWithoutFolder, installationForReader } from '../marketplace-reader.js';

const FOLDER = '/work/northwind-flow';
const HELD = {
  name: 'flow',
  reason: 'unasked' as const,
  reviewable: true,
  linkedPath: FOLDER,
  note: `Held back: you have not approved it. Linked: it runs whatever is in ${FOLDER}. Review it.`,
  bindsTo: `linked:${FOLDER}`,
};
const INSTALL = {
  name: 'flow',
  installPath: '/home/.dork/plugins/flow',
  heldBack: HELD,
  devLink: { path: FOLDER, state: 'active' as const, parked: false },
};
const PERSON: CapabilityHandlerContext = {};
const AGENT: CapabilityHandlerContext = {
  identity: {
    agentPath: '/projects/scout',
    displayName: 'Scout',
    createdAt: '2026-11-25T00:00:00Z',
  },
};
const TOKEN_ONLY: CapabilityHandlerContext = { agentIdentityPresented: true };

describe('an installation, by reader', () => {
  it('reaches a person whole', () => {
    expect(installationForReader(PERSON)(INSTALL)).toEqual(INSTALL);
  });

  it('reaches an agent, or a caller with an agent token, without the folder anywhere', () => {
    for (const context of [AGENT, TOKEN_ONLY]) {
      const read = installationForReader(context)(INSTALL);
      expect(JSON.stringify(read)).not.toContain(FOLDER);
      expect(read.devLink).toEqual({ state: 'active', parked: false });
      expect(read.heldBack?.note).toContain('whatever is in its folder.');
      expect(read.installPath).toBe(INSTALL.installPath);
    }
  });
});

describe('a held-back package', () => {
  it('loses the folder, and a binding that spells it, for an agent', () => {
    const read = heldBackWithoutFolder(HELD);
    expect(JSON.stringify(read)).not.toContain(FOLDER);
    expect(read).toMatchObject({ name: 'flow', reason: 'unasked', reviewable: true });
  });

  it('is unchanged when it is not linked', () => {
    const { linkedPath: _folder, ...plain } = {
      ...HELD,
      bindsTo: 'sha256:abc',
      note: 'Held back.',
    };
    expect(heldBackWithoutFolder(plain)).toEqual(plain);
  });
});
