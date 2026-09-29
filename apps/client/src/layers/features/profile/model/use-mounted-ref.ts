/**
 * Whether the calling surface is still on screen.
 *
 * @module features/profile/model/use-mounted-ref
 */
import { useEffect, useRef, type RefObject } from 'react';

/**
 * A ref that reads `true` while the calling component is mounted.
 *
 * For `meta.isShownInline` (`shared/lib/query-client.ts`): a surface that
 * reports a failure under its own field may keep the shared toast out of it
 * only while it is there to report it. A save that fails after the row
 * collapsed, the card was dismissed or Settings closed has nowhere else to be
 * seen, so it must toast.
 */
export function useMountedRef(): RefObject<boolean> {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
