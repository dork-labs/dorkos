import { assertObservation } from './mechanics-helpers.mjs';
/** Hash actual rendered canvas RGBA rather than receipt metadata or supplied capture bytes. */
export async function canvasHash(page) {
  return page.locator('#screen').evaluate(async (canvas) => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)), (n) =>
      n.toString(16).padStart(2, '0')
    ).join('');
  });
}
/** Independently screenshot the named Page, then decode its JPEG to the same pixel format. */
export async function canonicalHash(view, tab) {
  const bytes = await tab.page.screenshot({
    type: 'jpeg',
    quality: 70,
    animations: 'disabled',
    caret: 'initial',
  });
  return view.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (n) => n.charCodeAt(0));
    const bitmap = await globalThis.createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const canvas = globalThis.document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)), (n) =>
      n.toString(16).padStart(2, '0')
    ).join('');
  }, bytes.toString('base64'));
}
export async function assertCanonical(view, tab) {
  assertObservation(
    (await canvasHash(view)) === (await canonicalHash(view, tab)),
    'wrong-page-pixels'
  );
}
