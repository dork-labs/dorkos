import { describe, expect, it } from 'vitest';
import {
  PROVENANCE_ROUND_TRIP_PROVED,
  createProvenanceMarker,
  flyProvenanceNetwork,
  isCreatedWithinWindow,
  neonProvenanceRole,
} from '../provenance/provenance-gate.js';

describe('Community launch provenance', () => {
  // A service's marker counts as proof only once a live receipt shows the round trip. Both flags
  // were flipped in their own PR citing receipt dorkos-gate-376b14cf0957 (DOR-2238, phase 4).
  it('commits the round-trip gate open for Fly and Neon, as the live receipt showed', () => {
    expect(PROVENANCE_ROUND_TRIP_PROVED).toEqual({ fly: true, neon: true });
  });

  it('creates fresh 128-bit markers that stay valid network and role names', () => {
    const markers = new Set(Array.from({ length: 32 }, () => createProvenanceMarker()));
    expect(markers.size).toBe(32);
    for (const marker of markers) {
      expect(marker).toMatch(/^[a-f0-9]{32}$/u);
      expect(flyProvenanceNetwork(marker)).toBe(`dorkos-${marker}`);
      // Postgres role names are limited to 63 bytes.
      expect(neonProvenanceRole(marker)).toBe(`community_${marker}`);
      expect(neonProvenanceRole(marker).length).toBeLessThanOrEqual(63);
    }
  });

  describe('create window', () => {
    const requestedAt = '2026-09-23T10:31:03.000Z';
    const deadline = 5 * 60 * 1000;

    it('accepts a creation time inside the request, the deadline and a two-minute margin', () => {
      for (const createdAt of [
        '2026-09-23T10:29:03.000Z',
        '2026-09-23T10:31:07Z',
        '2026-09-23T10:38:03.000Z',
      ]) {
        expect(isCreatedWithinWindow(createdAt, requestedAt, deadline), createdAt).toBe(true);
      }
    });

    it('rejects a creation time outside the window', () => {
      for (const createdAt of ['2026-09-23T10:29:02.999Z', '2026-09-23T10:38:03.001Z']) {
        expect(isCreatedWithinWindow(createdAt, requestedAt, deadline), createdAt).toBe(false);
      }
    });

    // A service that reports no creation time, or a journal from before request times were
    // recorded, can never satisfy the window, so neither can ever be proved.
    it('treats a missing or unreadable time on either side as outside the window', () => {
      expect(isCreatedWithinWindow(undefined, requestedAt, deadline)).toBe(false);
      expect(isCreatedWithinWindow('2026-09-23T10:31:07Z', undefined, deadline)).toBe(false);
      expect(isCreatedWithinWindow('yesterday', requestedAt, deadline)).toBe(false);
      expect(isCreatedWithinWindow('2026-09-23T10:31:07Z', requestedAt, Number.NaN)).toBe(false);
      expect(isCreatedWithinWindow('2026-09-23T10:31:07Z', requestedAt, -1)).toBe(false);
    });
  });
});
