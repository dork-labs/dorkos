/**
 * The link a person opens a community at, and pastes into DorkOS to connect it: its short
 * address when it has one, otherwise its `/c/<id>` address. Both lead to this one community, so
 * both work in the app's Join a space…, where the host's bare address may not.
 *
 * @param origin - The host's origin, such as `https://spaces.example.com`.
 * @param communityId - The community's id.
 * @param shortName - Its short address, or `null` when it has none.
 */
export function communityLink(
  origin: string,
  communityId: string,
  shortName: string | null | undefined
): string {
  return shortName ? `${origin}/${shortName}` : `${origin}/c/${communityId}`;
}
