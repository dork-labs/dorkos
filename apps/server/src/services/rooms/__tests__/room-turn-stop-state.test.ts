import { describe, expect, it } from 'vitest';
import { createRoomTurnStopState } from '../turn/room-turn-stop-state.js';

describe('ordinary Room stop identity bookkeeping', () => {
  it('re-aims a pre-capture mark only at the runtime actually captured', () => {
    const state = createRoomTurnStopState<string>();
    state.begin('placeholder');
    state.oweSession('placeholder');
    const turn = state.capture('placeholder', 'claude-code');
    expect(state.consume(turn, 'placeholder')).toBe(true);
    expect(turn.runtime).toBe('claude-code');
    expect(state.consume(turn, 'placeholder')).toBe(false);
  });
  it('old retirement cannot remove a successor capture', () => {
    const state = createRoomTurnStopState<string>();
    const first = state.capture('shared', 'claude-code');
    const second = state.capture('shared', 'codex');
    state.forget(first);
    expect(state.current('shared')).toBe(second);
    expect(state.current('shared')?.runtime).toBe('codex');
  });
  it('a canonical alias owes the same turn and consumes once under its placeholder', () => {
    const state = createRoomTurnStopState<string>();
    const turn = state.capture('placeholder', 'claude-code');
    state.alias('canonical', turn);
    const reached = state.current('canonical');
    expect(reached).toBe(turn);
    state.oweTurn(turn);
    expect(state.consume(turn, 'placeholder')).toBe(true);
    expect(state.consume(turn, 'placeholder')).toBe(false);
  });
  it('a mark left on an old turn is not inherited under its shared canonical name', () => {
    const state = createRoomTurnStopState<string>();
    const first = state.capture('placeholder', 'claude-code');
    state.alias('canonical', first);
    state.oweTurn(first);
    state.forget(first);
    state.begin('placeholder');
    const second = state.capture('placeholder', 'claude-code');
    state.alias('canonical', second);
    expect(state.consume(second, 'placeholder')).toBe(false);
  });
  it('begin clears a capture left before collector acquisition even if no new capture follows', () => {
    const state = createRoomTurnStopState<string>();
    state.capture('session', 'claude-code');
    state.begin('session');
    expect(state.current('session')).toBeUndefined();
  });
  it('a next turn does not inherit an unconsumed session stop', () => {
    const state = createRoomTurnStopState<string>();
    state.oweSession('session');
    state.begin('session');
    const next = state.capture('session', 'claude-code');
    expect(state.consume(next, 'session')).toBe(false);
  });
});
