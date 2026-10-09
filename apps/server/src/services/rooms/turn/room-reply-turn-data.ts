/** Sequence/cancellation DATA only; no session/projector/producer or turn authority. */
export function shouldCancelUnstartedRoomReply(outcome: string, startSeq: number | null): boolean {
  return outcome === 'failed' && startSeq === null;
}

/** Read reply events only after the matching original turn_start sequence. */
export function createRoomReplyTurnGate(readStartSeq: () => number | null) {
  let started = false;
  return {
    /** Own turn_start anchors the read but is not itself assistant output. */
    read(type: string, seq: number): boolean {
      if (!started) {
        if (type !== 'turn_start' || seq !== readStartSeq()) return false;
        started = true;
        return false;
      }
      return true;
    },
  };
}
