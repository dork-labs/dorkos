/**
 * The host's look, as an app's frame mirrors it: light or dark mode and the
 * font choice from the host root (DOR-3293), plus the text size of the place
 * the frame sits in and the host's size scales (DOR-4330).
 *
 * A frame is its own document. Without these it would start at the browser's
 * 16 px, and the copied stylesheet's phone rule would test the frame's own
 * width, so a status item would draw larger than the 12 px bar around it.
 *
 * The frame runtime bundles this file, so it imports nothing at run time.
 *
 * @module features/extensions/frame/theme
 */
import type { FrameTheme } from './protocol';

/** The host's text, icon and control size scales (`index.css`). */
export const FRAME_SCALE_VARS = ['--_st', '--_si', '--_sb'] as const;

const PX_SIZE = /^\d+(\.\d+)?px$/;
const PLAIN_NUMBER = /^\d+(\.\d+)?$/;

/**
 * Read the host's look for a frame placed in `parent`.
 *
 * @param parent - The element the frame is placed in.
 */
export function readHostTheme(parent: HTMLElement): FrameTheme {
  const root = document.documentElement;
  const rootStyle = getComputedStyle(root);
  return {
    className: root.className,
    style: root.getAttribute('style') ?? '',
    fontSize: getComputedStyle(parent).fontSize,
    scales: Object.fromEntries(
      FRAME_SCALE_VARS.map((name) => [name, rootStyle.getPropertyValue(name).trim()])
    ),
  };
}

/**
 * Mirror the host's look onto a frame's document. The text size goes on the
 * body, not the root, so `rem` sizes still match the host's. Only a plain px
 * size and plain-number scales are applied; anything else leaves the frame's
 * own defaults.
 *
 * @param doc - The frame's document.
 * @param theme - The host's look, from {@link readHostTheme}.
 */
export function applyFrameTheme(doc: Document, theme: FrameTheme): void {
  const root = doc.documentElement;
  root.className = theme.className;
  root.setAttribute('style', theme.style);
  for (const name of FRAME_SCALE_VARS) {
    const value = theme.scales?.[name] ?? '';
    if (PLAIN_NUMBER.test(value)) root.style.setProperty(name, value);
  }
  doc.body.style.fontSize = PX_SIZE.test(theme.fontSize ?? '') ? theme.fontSize : '';
}
