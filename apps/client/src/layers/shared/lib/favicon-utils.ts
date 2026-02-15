const EMOJI_SET = [
  '\u{1F600}', '\u{1F60E}', '\u{1F916}', '\u{1F98A}', '\u{1F431}', '\u{1F436}', '\u{1F981}', '\u{1F438}', '\u{1F435}', '\u{1F984}',
  '\u{1F432}', '\u{1F989}', '\u{1F427}', '\u{1F43C}', '\u{1F98B}', '\u{1F338}', '\u{1F52E}', '\u{1F3AF}', '\u{1F680}', '\u{26A1}',
  '\u{1F30A}', '\u{1F340}', '\u{1F3A8}', '\u{1F3B5}', '\u{1F48E}', '\u{1F525}', '\u{1F308}', '\u{2B50}', '\u{1F9E0}', '\u{1F47E}',
];

export function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

export function hashToHslColor(cwd: string): string {
  const hue = fnv1aHash(cwd) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

export function hashToEmoji(cwd: string): string {
  return EMOJI_SET[fnv1aHash(cwd) % EMOJI_SET.length];
}

export function generateCircleFavicon(hslColor: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = hslColor;
  ctx.beginPath();
  ctx.arc(16, 16, 15, 0, Math.PI * 2);
  ctx.fill();

  return canvas.toDataURL('image/png');
}

export function generateDimmedFavicon(
  solidDataUrl: string,
  opacity = 0.4,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (!ctx) return reject(new Error('Canvas context unavailable'));

    const img = new Image();
    img.onload = () => {
      ctx.globalAlpha = opacity;
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = solidDataUrl;
  });
}

/**
 * Pre-render a sequence of favicon frames that smoothly pulse from full
 * opacity down to `minOpacity` and back using a sine-eased curve.
 * Cycling through the returned array at a fixed interval produces a
 * gentle breathing animation in the browser tab.
 */
export function generatePulseFrames(
  solidDataUrl: string,
  frameCount = 20,
  minOpacity = 0.3,
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
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('Canvas context unavailable')); return; }

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

export function setFavicon(dataUrl: string): void {
  let link = document.querySelector<HTMLLinkElement>("link[rel*='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = dataUrl;
}
