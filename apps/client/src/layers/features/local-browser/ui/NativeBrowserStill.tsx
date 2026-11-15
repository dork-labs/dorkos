import type { NativeBrowserStill as Still } from '../model/use-native-browser-surface';

/**
 * The covered page's still, drawn exactly where the page was (DOR-4438): same box,
 * no blur, dimming or fade, so the swap can't be seen. A dialog brings its own scrim.
 */
export function NativeBrowserStill({ still }: { still: Still }) {
  return (
    <img
      src={still.url}
      alt=""
      aria-hidden
      draggable={false}
      data-slot="native-browser-still"
      className="pointer-events-none absolute max-w-none select-none"
      style={{ left: still.left, top: still.top, width: still.width, height: still.height }}
    />
  );
}
