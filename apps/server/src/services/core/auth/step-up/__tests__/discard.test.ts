/** Resource cleanup follows every discarded hold, never take-for-commit. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STEP_UP_TTL_MS, STEP_UP_MAX_PASSWORD_TRIES } from '@dorkos/shared/step-up';
import {
  holdStepUp,
  cancelHeldStepUp,
  takeHeldStepUp,
  peekHeldStepUp,
  spendStepUpTry,
  resetHeldStepUpsForTests,
  MAX_HELD_STEP_UPS,
} from '../step-up-holds.js';

const action = (onDiscard: () => void, value = 0) => ({
  kind: 'cloud.space' as const,
  target: 'test-move',
  input: { value },
  reason: 'Move the space.',
  onDiscard,
  commit: async () => ({ status: 200, body: {} }),
});
afterEach(() => {
  resetHeldStepUpsForTests();
  vi.useRealTimers();
});
describe('discarded held action resources', () => {
  it('cleans up cancellation and expiration exactly once', () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const held = holdStepUp(action(cancelled), 'browser');
    cancelHeldStepUp(held.heldActionId);
    cancelHeldStepUp(held.heldActionId);
    expect(cancelled).toHaveBeenCalledOnce();
    const expired = vi.fn();
    holdStepUp(action(expired), 'browser');
    vi.advanceTimersByTime(STEP_UP_TTL_MS);
    expect(expired).toHaveBeenCalledOnce();
  });
  it('cleans up replacement, eviction and exhausted tries', () => {
    const replaced = vi.fn();
    holdStepUp(action(replaced), 'browser');
    holdStepUp(action(vi.fn()), 'browser');
    expect(replaced).toHaveBeenCalledOnce();
    resetHeldStepUpsForTests();
    const evicted = vi.fn();
    holdStepUp(action(evicted), 'browser');
    for (let i = 1; i <= MAX_HELD_STEP_UPS; i++) holdStepUp(action(vi.fn(), i), 'browser');
    expect(evicted).toHaveBeenCalledOnce();
    const exhausted = vi.fn();
    const held = holdStepUp(action(exhausted, 100), 'browser');
    for (let i = 0; i < STEP_UP_MAX_PASSWORD_TRIES; i++) spendStepUpTry(held.heldActionId);
    expect(exhausted).toHaveBeenCalledOnce();
  });
  it('transfers resources to the commit without discarding them', () => {
    const discard = vi.fn();
    const held = holdStepUp(action(discard), 'browser');
    expect(takeHeldStepUp(held.heldActionId)).toBeDefined();
    cancelHeldStepUp(held.heldActionId);
    expect(discard).not.toHaveBeenCalled();
  });
  it('keeps another browser’s confirmation while one browser floods its own holds', () => {
    const desk = holdStepUp(action(vi.fn(), -1), 'desk');
    for (let i = 0; i < 32; i++) holdStepUp(action(vi.fn(), i), 'remote');
    expect(peekHeldStepUp(desk.heldActionId)).toBeDefined();
  });
  it('refuses a full pool rather than evicting a different browser', () => {
    const desk = holdStepUp(action(vi.fn(), -1), 'desk');
    for (let i = 1; i < MAX_HELD_STEP_UPS; i++) holdStepUp(action(vi.fn(), i), `browser-${i}`);
    expect(() => holdStepUp(action(vi.fn(), 100), 'new-browser')).toThrow(
      'Too many actions are waiting.'
    );
    expect(peekHeldStepUp(desk.heldActionId)).toBeDefined();
  });
});
