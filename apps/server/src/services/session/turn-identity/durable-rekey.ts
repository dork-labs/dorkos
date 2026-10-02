/** Synchronous durable rekey participants run before projector notifications. */
type DurableRekeyParticipant = (fromId: string, toId: string) => void;
const participants = new Set<DurableRekeyParticipant>();
/** Register an atomic store move; failures remain durable and do not stop the runtime's identity change. */
export function onDurableSessionRekey(participant: DurableRekeyParticipant): () => void {
  participants.add(participant);
  return () => {
    participants.delete(participant);
  };
}
/** Run registered durable moves before generic queue rows or in-memory aliases move. */
export function moveDurableSessionIdentity(fromId: string, toId: string): void {
  for (const participant of participants) participant(fromId, toId);
}
