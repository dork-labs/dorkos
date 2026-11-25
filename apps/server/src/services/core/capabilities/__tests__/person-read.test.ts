/**
 * The REST-path person proof skips only an area's Blocked default, only for a
 * read (DOR-4978). Everything else the gate resolved still applies.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';

import { personReadsPastArea } from '../context/person-read.js';
import { personCaller } from '../trusted-caller.js';
import type { CallPermission } from '../permission-enforcement.js';

const LOCAL = {
  agentIdentityPresented: false,
  approvalTokenPresented: false,
  loginEnabled: () => false,
  authorizationPresented: false,
};
const restProof = personCaller(LOCAL, { readGroup: 'address:127.0.0.1' });
const blockedArea: CallPermission = {
  area: 'todos',
  state: 'blocked',
  source: 'default-area',
  layer: 'default',
};

describe('personReadsPastArea', () => {
  it('passes a read with the REST proof past the area’s Blocked default', () => {
    expect(personReadsPastArea({ tier: 'observe' }, { person: restProof }, blockedArea)).toBe(true);
  });

  it('passes a read past the preset’s Blocked for the area', () => {
    const preset: CallPermission = { ...blockedArea, source: 'preset' };
    expect(personReadsPastArea({ tier: 'observe' }, { person: restProof }, preset)).toBe(true);
  });

  it('never counts for act or destructive', () => {
    for (const tier of ['act', 'destructive'] as const) {
      expect(personReadsPastArea({ tier }, { person: restProof }, blockedArea)).toBe(false);
    }
  });

  it('never counts for a person proof /invoke minted, or none', () => {
    const invokeProof = personCaller(LOCAL);
    expect(personReadsPastArea({ tier: 'observe' }, { person: invokeProof }, blockedArea)).toBe(
      false
    );
    expect(personReadsPastArea({ tier: 'observe' }, {}, blockedArea)).toBe(false);
    expect(
      personReadsPastArea({ tier: 'observe' }, { person: { from: 'rest-proof' } }, blockedArea)
    ).toBe(false);
  });

  it('never counts beside an agent identity', () => {
    const supplied = { person: restProof, identity: { agentPath: '/projects/scout' } };
    expect(personReadsPastArea({ tier: 'observe' }, supplied, blockedArea)).toBe(false);
  });

  it('skips only the area: action settings, a floor, a keeper and an unreadable config still refuse', () => {
    const still: CallPermission[] = [
      { ...blockedArea, source: 'default-action' },
      { ...blockedArea, source: 'floor', layer: 'floor' },
      { ...blockedArea, unreadable: true },
      { ...blockedArea, keeperRefusal: 'A person must change this.' },
      // The preset's own entry for the action reports `preset` too.
      { ...blockedArea, source: 'preset', actionLevel: true },
    ];
    for (const permission of still) {
      expect(personReadsPastArea({ tier: 'observe' }, { person: restProof }, permission)).toBe(
        false
      );
    }
  });
});
