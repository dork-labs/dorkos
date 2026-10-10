/** Nonissuing bookkeeping for an owner row written before provider launch. */
export function createRoomLaunchOwnerRollback() {
  let minted = false;
  return {
    record(bound: boolean, firstConversation: boolean): void {
      minted = bound && firstConversation;
    },
    take(): boolean {
      if (!minted) return false;
      minted = false;
      return true;
    },
  };
}
