import { describe, it, expect } from 'vitest';
import { SHOTS, getShot, isAutoSkipped, shotTargetDimensions, shotsManifest } from '../shots.js';

/**
 * Unit tests for the shot registry — the pipeline's source of truth. These pin
 * the invariants the published manifest and the marketing/docs guard tests rely
 * on.
 *
 * @module capture/__tests__/shots
 */
describe('shot registry', () => {
  it('has unique, non-empty shot ids', () => {
    const ids = SHOTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('gives every shot at least one consumer', () => {
    for (const shot of SHOTS) expect(shot.consumers.length).toBeGreaterThan(0);
  });

  it('resolves shots by id and reports unknown ids as undefined', () => {
    expect(getShot('cockpit')?.frame).toBe('desktop');
    expect(getShot('mobile-chat')?.frame).toBe('mobile');
    expect(getShot('does-not-exist')).toBeUndefined();
  });

  it('marks no shot skipAuto by default', () => {
    for (const shot of SHOTS) expect(isAutoSkipped(shot.id)).toBe(false);
  });

  it('projects a manifest snapshot with only id/kind/frame/consumers', () => {
    const manifest = shotsManifest();
    expect(manifest).toHaveLength(SHOTS.length);
    for (const entry of manifest) {
      expect(Object.keys(entry).sort()).toEqual(['consumers', 'frame', 'id', 'kind']);
    }
  });

  describe('target dimensions', () => {
    it('desktop still is 2560×1600 (1280×800 @2x)', () => {
      expect(shotTargetDimensions(getShot('cockpit')!, 'still')).toEqual({
        width: 2560,
        height: 1600,
      });
    });

    it('desktop loop is the 1280×800 logical video size', () => {
      expect(shotTargetDimensions(getShot('topology')!, 'loop')).toEqual({
        width: 1280,
        height: 800,
      });
    });

    it('mobile still is 1170×2532 (390×844 @3x)', () => {
      expect(shotTargetDimensions(getShot('mobile-sessions')!, 'still')).toEqual({
        width: 1170,
        height: 2532,
      });
    });

    it('mobile loop is the 390×844 logical video size', () => {
      expect(shotTargetDimensions(getShot('mobile-chat')!, 'loop')).toEqual({
        width: 390,
        height: 844,
      });
    });
  });
});
