import { AGENT_EMOJI_SET, fnv1aHash } from '@dorkos/shared/agent-face';

/**
 * The curated sets an agent's face is drawn from, re-exported here because the
 * SERVER seeds a face from them at creation (DOR-949) and the picker must offer
 * the same ones back. `@dorkos/shared/agent-face` owns the definitions; a
 * second copy on either side is how the two would come to disagree.
 */
export { AGENT_EMOJI_SET, AGENT_COLOR_PRESETS, fnv1aHash } from '@dorkos/shared/agent-face';

/** Derive a deterministic HSL color string from a directory path. */
export function hashToHslColor(cwd: string): string {
  const hue = fnv1aHash(cwd) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

/** Pick a deterministic emoji from {@link AGENT_EMOJI_SET} based on a directory path. */
export function hashToEmoji(cwd: string): string {
  return AGENT_EMOJI_SET[fnv1aHash(cwd) % AGENT_EMOJI_SET.length];
}

const FAVICON_SIZE = 32;
const FAVICON_CENTER = FAVICON_SIZE / 2;
const FAVICON_RADIUS = FAVICON_SIZE / 2 - 1;

/** Render a solid-color circle to a canvas and return it as a data URL for use as a favicon. */
export function generateCircleFavicon(hslColor: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = FAVICON_SIZE;
  canvas.height = FAVICON_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = hslColor;
  ctx.beginPath();
  ctx.arc(FAVICON_CENTER, FAVICON_CENTER, FAVICON_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  return canvas.toDataURL('image/png');
}

/**
 * Pre-render a sequence of favicon frames that smoothly tasks from full
 * opacity down to `minOpacity` and back using a sine-eased curve.
 * Cycling through the returned array at a fixed interval produces a
 * gentle breathing animation in the browser tab.
 */
export function generateTasksFrames(
  solidDataUrl: string,
  frameCount = 20,
  minOpacity = 0.3
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const frames: string[] = [];
      for (let i = 0; i < frameCount; i++) {
        // Sine curve: smoothly eases 0→1→0 over one cycle
        const t = Math.sin((i / frameCount) * Math.PI);
        const opacity = 1 - t * (1 - minOpacity);

        const canvas = document.createElement('canvas');
        canvas.width = FAVICON_SIZE;
        canvas.height = FAVICON_SIZE;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas context unavailable'));
          return;
        }

        ctx.globalAlpha = opacity;
        ctx.drawImage(img, 0, 0);
        frames.push(canvas.toDataURL('image/png'));
      }
      resolve(frames);
    };
    img.onerror = reject;
    img.src = solidDataUrl;
  });
}

/** Set or create the document's favicon link element with the given data URL. */
export function setFavicon(dataUrl: string): void {
  let link = document.querySelector<HTMLLinkElement>("link[rel*='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = dataUrl;
}
