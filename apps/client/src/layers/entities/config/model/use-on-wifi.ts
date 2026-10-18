import { useConfig } from './use-config';

/**
 * Whether this browser reached DorkOS over the Wi-Fi listener (DOR-2969), as
 * `GET /api/config` reports in `callerRoute`. From Wi-Fi an approval is Allow
 * once or Deny, so approval cards hide "Always allow" there; the server
 * refuses it anyway, this only keeps the card from offering it.
 *
 * Unknown (still loading, or an older server) reads as not Wi-Fi: the card
 * then offers what it always has, and the server's refusal is the floor.
 *
 * @returns `true` only when the server said this request came over Wi-Fi.
 */
export function useOnWifi(): boolean {
  return useConfig().data?.callerRoute === 'wifi';
}
