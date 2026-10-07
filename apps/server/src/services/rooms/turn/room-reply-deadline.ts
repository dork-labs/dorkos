/** Ordinary reply timing DATA. This module never admits or reads a session/Room producer. */
export interface RoomReplyTimingData {
  text: string | null;
  failed: boolean;
  waitedMs: number;
}

/** Capture the collector's original Date clock at subscription, with no clock substitution. */
export function createRoomReplyElapsedClock(): () => number {
  const startedAt = Date.now();
  return () => Date.now() - startedAt;
}

/** Race the one actual completion against its original wait timer; retain that same completion late. */
export function createRoomReplyDeadline<T extends RoomReplyTimingData>(
  closed: Promise<T>,
  waitMs: number
) {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const passed = new Promise<null>((resolve) => {
    deadline = setTimeout(() => resolve(null), waitMs);
    deadline.unref?.();
  });
  return {
    beforeDeadline: Promise.race([
      closed.then((turn) => {
        clearTimeout(deadline);
        return turn;
      }),
      passed,
    ]),
    afterDeadline: closed.then((turn) => ({
      text: turn.text,
      waitedMs: turn.waitedMs,
      ...(turn.failed ? { unanswered: 'failed' as const } : {}),
    })),
    clear: () => clearTimeout(deadline),
  };
}
