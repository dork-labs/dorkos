import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MotionGlobalConfig } from 'motion/react';
import { DURATION, EASE, SPRING, STAGGER, installReducedMotion } from '../motion';

// The client's test setup mocks `motion/react`; this file needs the real switch.
vi.mock('motion/react', async (importOriginal) => importOriginal());

const css = readFileSync(resolve(__dirname, '../../../../index.css'), 'utf8');

/** A CSS custom property's value from `index.css`. */
function cssToken(name: string): string | undefined {
  return new RegExp(`${name}:\\s*([^;]+);`).exec(css)?.[1];
}

describe('motion tokens', () => {
  it.each(Object.entries(DURATION))('--dur-%s matches DURATION', (name, seconds) => {
    expect(cssToken(`--dur-${name}`)).toBe(`${Math.round(seconds * 1000)}ms`);
  });

  it.each(Object.entries(EASE))('--ease-%s matches EASE', (name, curve) => {
    expect(cssToken(`--ease-${name}`)).toBe(`cubic-bezier(${curve.join(', ')})`);
  });

  it.each(Object.entries(SPRING))('the %s spring never visibly bounces', (_name, spring) => {
    expect(spring.damping / (2 * Math.sqrt(spring.stiffness))).toBeGreaterThanOrEqual(0.9);
  });

  it('keeps the stagger the spec names', () => {
    expect(STAGGER).toEqual({ step: 0.035, max: 8 });
  });
});

describe('installReducedMotion', () => {
  afterEach(() => {
    MotionGlobalConfig.skipAnimations = false;
    vi.unstubAllGlobals();
  });

  function stubPreference(matches: boolean) {
    const listeners: Array<() => void> = [];
    const query = {
      matches,
      addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
    };
    vi.stubGlobal('matchMedia', () => query);
    return {
      change(next: boolean) {
        query.matches = next;
        listeners.forEach((listener) => listener());
      },
    };
  }

  it('finishes animations at once when the reader asks for less motion', () => {
    stubPreference(true);
    installReducedMotion();
    expect(MotionGlobalConfig.skipAnimations).toBe(true);
  });

  it('leaves animations running otherwise', () => {
    stubPreference(false);
    installReducedMotion();
    expect(MotionGlobalConfig.skipAnimations).toBe(false);
  });

  it('follows the setting when it changes mid-session', () => {
    const preference = stubPreference(false);
    installReducedMotion();
    preference.change(true);
    expect(MotionGlobalConfig.skipAnimations).toBe(true);
    preference.change(false);
    expect(MotionGlobalConfig.skipAnimations).toBe(false);
  });
});
