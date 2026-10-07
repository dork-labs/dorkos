import { describe, expect, it } from 'vitest';
import {
  createNodeBrokerTransport,
  createProductionNodeBrokerTransport,
  isOriginalProductionNodeTransport,
} from '../node/node-transport.js';
import { createPrivateBroker } from '../broker.js';
import { createPreparedProductionBroker } from '../production-broker.js';
import { createProductionLiveBrowserComposition } from '../live/production-composition.js';

describe('production admission provenance', () => {
  it('recognizes only exact original Node factory objects, never a tag or copied port', () => {
    const original = createProductionNodeBrokerTransport();
    expect(isOriginalProductionNodeTransport(original)).toBe(true);
    expect(isOriginalProductionNodeTransport({ ...original })).toBe(false);
    expect(isOriginalProductionNodeTransport(createNodeBrokerTransport())).toBe(false);
    expect(isOriginalProductionNodeTransport({ scope: 'server-owned' })).toBe(false);
    expect(original.intake).toBe('listener-owned');
  });
  it('keeps the original fixture constructor closed to production-tagged IO', () => {
    const original = createProductionNodeBrokerTransport();
    // Negative incomplete caller does not reach issuer/IO callbacks.
    expect(() =>
      createPrivateBroker({ transport: original } as unknown as Parameters<
        typeof createPrivateBroker
      >[0])
    ).toThrowError(expect.objectContaining({ code: 'UNAVAILABLE' }));
  });
  it('checks original prepared issuer custody before constructing/listening', () => {
    let calls = 0;
    const issuer = {
      checkPrepared() {
        calls++;
        throw false;
      },
    };
    const options = { issuer, run: {}, receiver: {} } as unknown as Parameters<
      typeof createPreparedProductionBroker
    >[0];
    try {
      createPreparedProductionBroker(options);
      throw new Error('expected original refusal');
    } catch (reason) {
      expect(reason).toBe(false);
    }
    expect(calls).toBe(1);
  });
  it('refuses missing actual native configuration before creating policy/readiness', () => {
    expect(() =>
      createProductionLiveBrowserComposition({ engineConfiguration: {} } as unknown as Parameters<
        typeof createProductionLiveBrowserComposition
      >[0])
    ).toThrow();
  });
});
