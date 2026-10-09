import assert from 'node:assert/strict';
import { createRoomTurnStopState } from '../../turn/room-turn-stop-state.js';

/** Ordinary algorithm predicates, never a private request or native producer. */
export function runOriginalRoomStopStateComponent(mode: number): void {
  const state = createRoomTurnStopState<string>();
  const deliveries: string[] = [];
  if (mode === 0) {
    state.begin('placeholder');
    assert.deepEqual([...deliveries], []);
    deliveries.push('codex');
    state.oweSession('placeholder');
    const turn = state.capture('placeholder', 'claude-code');
    if (state.consume(turn, 'placeholder')) deliveries.push(turn.runtime);
    assert.deepEqual(deliveries, ['codex', 'claude-code']);
    assert.equal(state.consume(turn, 'placeholder'), false);
  } else if (mode === 1) {
    const first = state.capture('shared', 'claude-code');
    const second = state.capture('shared', 'codex');
    state.forget(first);
    assert.equal(state.current('shared'), second);
    deliveries.push(state.current('shared')!.runtime);
    assert.equal(deliveries.at(-1), 'codex');
  } else if (mode === 2) {
    const turn = state.capture('placeholder-boot', 'claude-code');
    state.alias('canonical-boot', turn);
    assert.equal(state.current('canonical-boot'), turn);
    deliveries.push('canonical-boot');
    state.oweTurn(turn);
    if (state.consume(turn, 'placeholder-boot')) deliveries.push('placeholder-boot');
    assert.deepEqual(deliveries, ['canonical-boot', 'placeholder-boot']);
    assert.equal(state.consume(turn, 'placeholder-boot'), false);
  } else if (mode === 3) {
    const first = state.capture('shared-sess', 'claude-code');
    state.alias('canonical-shared', first);
    state.oweTurn(first);
    deliveries.push('canonical-shared');
    state.forget(first);
    state.begin('shared-sess');
    const second = state.capture('shared-sess', 'claude-code');
    state.alias('canonical-shared', second);
    if (state.consume(second, 'shared-sess')) deliveries.push('shared-sess');
    assert.equal(deliveries.length, 1);
  } else if (mode === 4) {
    state.capture('sess-leaked', 'claude-code');
    state.begin('sess-leaked');
    assert.equal(state.current('sess-leaked'), undefined);
    // The next refused registration must leave no old capture to answer a stop.
    deliveries.push(state.current('sess-leaked')?.runtime ?? 'codex');
    assert.deepEqual(deliveries, ['codex']);
  } else {
    assert.equal(mode, 5);
    state.oweSession('sess-again');
    deliveries.push('sess-again');
    state.begin('sess-again');
    const next = state.capture('sess-again', 'claude-code');
    if (state.consume(next, 'sess-again')) deliveries.push('sess-again');
    assert.equal(deliveries.length, 1);
  }
}
