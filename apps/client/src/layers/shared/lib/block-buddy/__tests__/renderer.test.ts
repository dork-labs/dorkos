/**
 * The package's frozen numbers, pinned at the one seam DorkOS calls (DOR-3065).
 * A genome change is an identity change, so any of these moving needs Dorian.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RENDERER_VERSION } from 'blockbuddies/render';
import { buddyGround, buddyHash, drawBuddy } from '../renderer';

/** A made-up agent id in the shape registration assigns. */
const AGENT_ID = '01M50ZCM5KZF236JGK50H6HFJM';

describe('the temporary seed', () => {
  it('hashes the id with sha256, as hashFromId promises', () => {
    const sha = createHash('sha256').update(AGENT_ID).digest('hex');
    expect(buddyHash(AGENT_ID)).toBe(`0x${sha}`);
  });

  it('pins the renderer this branch was reviewed on', () => {
    expect(RENDERER_VERSION).toBe('bb-render 1.10.2 (2026-10-22)');
  });

  // For the swap PR (DOR-3065), when `blockbuddies` ships names. The nickname
  // becomes the seed, and these vectors are what prove the swap.
  it.skip('seeds from the nickname once names ship (DOR-3065)', () => {
    // nicknameForId('01M50ZCM5KZF236JGK50H6HFJM') === 'Core Sloth'
    // names generator fingerprint (buddy-0..9999): 5a8e206f46b5c59c
    // names list fingerprint: 5e1a3abb4a485a99
    // plus Cody's 10 nameHash vectors, in names/NAMES.md
  });
});

describe('drawBuddy', () => {
  it('draws the same face for the same seed, every time', () => {
    expect(drawBuddy(AGENT_ID, 36, 'idle')).toBe(drawBuddy(AGENT_ID, 36, 'idle'));
    expect(drawBuddy(AGENT_ID, 36, 'idle')).not.toBe(
      drawBuddy('01M50ZCM5KZF236JGK50H6HFJN', 36, 'idle')
    );
  });

  it('holds a different pose for a different state', () => {
    expect(drawBuddy(AGENT_ID, 36, 'needs-you')).not.toBe(drawBuddy(AGENT_ID, 36, 'idle'));
  });

  it('draws decoration only: no label, no role and no tooltip', () => {
    for (const mode of ['idle', 'working', 'needs-you', 'error', 'offline'] as const) {
      const svg = drawBuddy(AGENT_ID, 28, mode);
      expect(svg).toMatch(/^<svg/);
      expect(svg).not.toMatch(/role=|aria-label=|<title>/);
    }
  });
});

describe('buddyGround', () => {
  it('gives the tile’s ground as a CSS colour', () => {
    expect(buddyGround(AGENT_ID)).toMatch(/^hsl\(/);
  });
});
