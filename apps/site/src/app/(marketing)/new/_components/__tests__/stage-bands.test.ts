import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BEAT_BOUNDARIES, BEAT_ORDER, beatProgressAt, nextBeat } from '../beats';
import { bandProgressAt, steadyBandIndex } from '../stage/stage-bands';

const THIRDS = [1 / 3, 2 / 3];
const STAGE = readFileSync(join(import.meta.dirname, '..', 'StageSection.tsx'), 'utf8');

describe('bands', () => {
  it('says how far through its own band a reader is', () => {
    // The whole point of the rail: 40% through the stage is 14% through beat
    // two, not 40% of anything. A rail that draws the first number is lying.
    expect(bandProgressAt(0, THIRDS)).toBe(0);
    expect(bandProgressAt(0.5, THIRDS)).toBeCloseTo(0.5, 5);
    expect(bandProgressAt(1 / 3, THIRDS)).toBeCloseTo(0, 5);
    expect(bandProgressAt(0.4, BEAT_BOUNDARIES)).toBeCloseTo((0.4 - 0.36) / (0.64 - 0.36), 5);
  });

  it('restarts the fill at each boundary rather than running on', () => {
    // A rail that kept counting would be full at the end of step one and
    // still full at the start of step two, which reads as nothing happening.
    // This is the raw cut, with no dead zone in it — where a band ends.
    expect(bandProgressAt(0.359, BEAT_BOUNDARIES)).toBeGreaterThan(0.99);
    expect(bandProgressAt(0.361, BEAT_BOUNDARIES)).toBeLessThan(0.01);
    expect(bandProgressAt(0.639, BEAT_BOUNDARIES)).toBeGreaterThan(0.99);
    expect(bandProgressAt(0.641, BEAT_BOUNDARIES)).toBeLessThan(0.01);
    expect(bandProgressAt(1, BEAT_BOUNDARIES)).toBe(1);
  });

  it('holds the reader still while they rest on a boundary', () => {
    // Inside the dead zone the band does not change, whichever side you are on.
    expect(steadyBandIndex(0.34, THIRDS, 0)).toBe(0);
    expect(steadyBandIndex(0.345, THIRDS, 0)).toBe(0);
    expect(steadyBandIndex(0.36, THIRDS, 0)).toBe(1);
    expect(steadyBandIndex(0.32, THIRDS, 1)).toBe(1);
    expect(steadyBandIndex(0.31, THIRDS, 1)).toBe(0);
  });

  it('lets a jump of two bands through, dead zone or not', () => {
    // A reader who arrives two steps away is not resting on a line, and
    // holding them back would leave the rail lit on a beat nobody is in.
    expect(steadyBandIndex(5 / 6, THIRDS, 0)).toBe(2);
  });
});

describe('the stage’s own beats', () => {
  it('changes beat exactly where it always did', () => {
    // The four thresholds the beat switch used to spell out, now derived from
    // two boundaries and one dead zone. Same numbers, one source, and the step
    // rail reads that source rather than inventing its own.
    expect(nextBeat(0, 'talk')).toBe('talk');
    expect(nextBeat(0.34, 'talk')).toBe('talk');
    expect(nextBeat(0.37, 'talk')).toBe('talk');
    expect(nextBeat(0.39, 'talk')).toBe('yours');
    expect(nextBeat(0.61, 'computer')).toBe('yours');
    expect(nextBeat(0.65, 'computer')).toBe('computer');
    expect(nextBeat(0.65, 'yours')).toBe('yours');
    expect(nextBeat(0.67, 'yours')).toBe('computer');
    expect(nextBeat(1, 'talk')).toBe('computer');
  });

  it('hands the rail beat progress, not stage progress', () => {
    // The rail's whole job is to be true about where you are inside the beat
    // you are in. Feeding it the scroll's own fraction would leave it 76% full
    // on step three while the machine is only a third of the way up, and a
    // rail that disagrees with the picture is worse than no rail.
    //
    // Asserted against the source rather than the render: the fill is a motion
    // value on a 3px bar, and jsdom reports every element as 0x0, so nothing
    // about it can be measured here. The browser pass covers the picture.
    expect(STAGE).toContain('beatProgressAt(v)');
    expect(STAGE).toContain('within={withinBeat}');
    expect(STAGE).not.toMatch(/within=\{progress\}/);
  });

  it('numbers the beats the way the step rail counts them', () => {
    expect(BEAT_ORDER).toEqual(['talk', 'yours', 'computer']);
    expect(BEAT_BOUNDARIES).toHaveLength(BEAT_ORDER.length - 1);
    expect(beatProgressAt(0.36)).toBeCloseTo(0, 5);
    expect(beatProgressAt(0.64)).toBeCloseTo(0, 5);
    expect(beatProgressAt(1)).toBeCloseTo(1, 5);
  });
});
