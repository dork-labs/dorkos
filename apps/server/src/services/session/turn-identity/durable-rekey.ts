/** Synchronous durable rekey participants run before projector notifications. */
type DurableRekeyParticipant = (fromId: string, toId: string, owner?: () => boolean) => void;
const participants = new Set<DurableRekeyParticipant>();
const required = new Set<DurableRekeyParticipant>();
/** Register an atomic store move; failures remain durable and do not stop the runtime's identity change. */
export function onDurableSessionRekey(participant: DurableRekeyParticipant): () => void {
  participants.add(participant);
  return () => {
    participants.delete(participant);
  };
}
/** Register mandatory identity carry, before optional replay/decorative participants. */
export function onRequiredSessionRekey(participant: DurableRekeyParticipant): () => void {
  required.add(participant);
  return () => {
    required.delete(participant);
  };
}
/** Run registered durable moves before generic queue rows or in-memory aliases move. */
export function moveDurableSessionIdentity(
  fromId: string,
  toId: string,
  owner?: () => boolean
): void {
  for (const participant of required) participant(fromId, toId, owner);
  for (const participant of participants) participant(fromId, toId);
}
