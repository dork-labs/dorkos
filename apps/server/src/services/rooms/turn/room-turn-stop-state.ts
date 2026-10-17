/** Ordinary per-run stop bookkeeping. It contains no request or authority issuer. */
export interface RoomTurnStopCapture<T> {
  readonly runtime: T;
  stopOwed: boolean;
  readonly ids: Set<string>;
}

/** Preserve stop-once and identity-guarded retirement across a turn's aliases. */
export function createRoomTurnStopState<T>() {
  const pending = new Set<string>();
  const current = new Map<string, RoomTurnStopCapture<T>>();
  return {
    begin(id: string): void {
      pending.delete(id);
      current.delete(id);
    },
    clearPending(id: string): boolean {
      return pending.delete(id);
    },
    capture(id: string, runtime: T): RoomTurnStopCapture<T> {
      const turn = { runtime, stopOwed: false, ids: new Set([id]) };
      current.set(id, turn);
      return turn;
    },
    alias(id: string, turn: RoomTurnStopCapture<T>): void {
      turn.ids.add(id);
      current.set(id, turn);
    },
    current(id: string): RoomTurnStopCapture<T> | undefined {
      return current.get(id);
    },
    oweTurn(turn: RoomTurnStopCapture<T>): void {
      turn.stopOwed = true;
    },
    oweSession(id: string): void {
      pending.add(id);
    },
    consume(turn: RoomTurnStopCapture<T>, id: string): boolean {
      const owedToTurn = turn.stopOwed;
      const owedToSession = pending.delete(id);
      if (!owedToTurn && !owedToSession) return false;
      turn.stopOwed = false;
      return true;
    },
    forget(turn: RoomTurnStopCapture<T>): void {
      for (const id of turn.ids) {
        if (current.get(id) === turn) current.delete(id);
      }
    },
  };
}
