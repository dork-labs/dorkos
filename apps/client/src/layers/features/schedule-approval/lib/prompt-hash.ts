/**
 * The hash of the prompt an approval card shows (DOR-3703, M4): the same
 * `sha256:<base64url>` the server attests a SKILL file by, so the card's yes
 * names exactly the text the person had in front of them.
 *
 * @module features/schedule-approval/lib/prompt-hash
 */

/**
 * `sha256:` and the base64url SHA-256 of the prompt's UTF-8 bytes, or `undefined`
 * on a plain-http page, where browsers leave out `crypto.subtle`. A yes with no
 * hash still approves the schedule; it attests no file, so the next run is capped.
 *
 * @param prompt - The prompt as the card shows it.
 */
export async function promptHash(prompt: string): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prompt));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  const base64url = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `sha256:${base64url}`;
}
