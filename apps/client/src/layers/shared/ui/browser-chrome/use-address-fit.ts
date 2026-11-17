import { useLayoutEffect, useState, type RefObject } from 'react';
import { ROOMY_ADDRESS_FIT, chooseAddressFit, type AddressFit } from './address-fit';

/** The at-rest field's normal left padding, `px-2`. */
const PADDING_LEFT_PX = 8;
/** Its tightened left padding, `pl-0.5`. */
export const TIGHT_PADDING_LEFT_PX = 2;
/** The gap between "Not secure" and the host, `gap-1.5`. */
const GAP_PX = 6;

/** The width of the measuring copy's part marked `data-measure={name}`, or 0 without one. */
function measured(root: HTMLElement, name: string): number {
  const part = root.querySelector<HTMLElement>(`[data-measure="${name}"]`);
  return part ? part.getBoundingClientRect().width : 0;
}

/**
 * Measure the at-rest address field and choose how its address fits
 * (`chooseAddressFit`), again whenever the field resizes. `measure` is a hidden
 * copy of the parts at their normal size, so a choice never feeds its own
 * measurement. With no layout yet (a width of 0) everything shows, as with room.
 *
 * @param field - The at-rest field.
 * @param measure - The hidden copy, its parts marked `data-measure`.
 * @param key - Changes whenever what is drawn changes (the address, the mark).
 */
export function useAddressFit(
  field: RefObject<HTMLElement | null>,
  measure: RefObject<HTMLElement | null>,
  key: string
): AddressFit {
  const [fit, setFit] = useState<AddressFit>(ROOMY_ADDRESS_FIT);
  useLayoutEffect(() => {
    const box = field.current;
    const copy = measure.current;
    if (!box || !copy) return;
    const choose = () => {
      const width = box.clientWidth;
      const host = measured(copy, 'host');
      if (width === 0 || host === 0) {
        setFit(ROOMY_ADDRESS_FIT);
        return;
      }
      const paddingRight = parseFloat(getComputedStyle(box).paddingRight) || 0;
      const next = chooseAddressFit({
        available: width - PADDING_LEFT_PX - paddingRight,
        paddingGain: PADDING_LEFT_PX - TIGHT_PADDING_LEFT_PX,
        gap: GAP_PX,
        badgeFull: measured(copy, 'badge'),
        badgeIcon: measured(copy, 'badge-icon'),
        host,
        kept: measured(copy, 'kept'),
        ellipsis: measured(copy, 'ellipsis'),
        baseFontPx: parseFloat(getComputedStyle(copy).fontSize) || 16,
      });
      setFit((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };
    choose();
    const observer = new ResizeObserver(choose);
    observer.observe(box);
    return () => observer.disconnect();
  }, [field, measure, key]);
  return fit;
}
