// Canonical B tabs/raster.ts parser; types erased only. Header proof is not pixel decoding.
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION = 16384;
const MAX_PIXELS = 8 * 1024 * 1024;
function refused() {
  throw new Error('JPEG_HEADER_REFUSED');
}
function word(bytes, at) {
  if (at + 1 >= bytes.length) refused();
  return bytes[at] * 256 + bytes[at + 1];
}
function marker(bytes, at) {
  if (bytes[at++] !== 255) refused();
  while (bytes[at] === 255) at++;
  if (at >= bytes.length) refused();
  return { code: bytes[at], next: at + 1 };
}
function frame(bytes, at, end) {
  const height = word(bytes, at + 1),
    width = word(bytes, at + 3),
    count = bytes[at + 5];
  if (
    bytes[at] !== 8 ||
    ![1, 3].includes(count) ||
    end - at !== 6 + 3 * count ||
    width < 1 ||
    height < 1 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  )
    refused();
  const components = new Set();
  let samples = 0;
  for (let i = 0; i < count; i++) {
    const id = bytes[at + 6 + i * 3],
      sampling = bytes[at + 7 + i * 3];
    const horizontal = sampling >> 4,
      vertical = sampling & 15;
    if (
      components.has(id) ||
      horizontal < 1 ||
      horizontal > 4 ||
      vertical < 1 ||
      vertical > 4 ||
      bytes[at + 8 + i * 3] > 3
    )
      refused();
    components.add(id);
    samples += horizontal * vertical;
  }
  if (samples > 10) refused();
  return { raster: { width, height, format: 'jpeg' }, components };
}
function scan(bytes, at, end, components) {
  const count = bytes[at];
  if (count !== components.size || end - at !== 1 + 2 * count + 3) refused();
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    const id = bytes[at + 1 + 2 * i],
      tables = bytes[at + 2 + 2 * i];
    if (!components.has(id) || seen.has(id) || tables >> 4 > 3 || (tables & 15) > 3) refused();
    seen.add(id);
  }
  if (bytes[end - 3] !== 0 || bytes[end - 2] !== 63 || bytes[end - 1] !== 0) refused();
}
function entropy(bytes, at, restart) {
  while (at < bytes.length) {
    if (bytes[at++] !== 255) continue;
    while (bytes[at] === 255) at++;
    const code = bytes[at++];
    if (code === 0) continue;
    if (code >= 208 && code <= 215 && restart > 0) continue;
    if (code === 217 && at === bytes.length) return;
    refused();
  }
  refused();
}
/** Admit only bounded baseline, single-scan JPEG headers without decoding pixels. */
export function readJpegRaster(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BYTES || word(bytes, 0) !== 65496)
    refused();
  let at = 2,
    restart = 0;
  let header;
  while (at < bytes.length) {
    const m = marker(bytes, at);
    at = m.next;
    const length = word(bytes, at),
      end = at + length;
    if (length < 2 || end > bytes.length) refused();
    const payload = at + 2;
    if (m.code === 192) {
      if (header) refused();
      header = frame(bytes, payload, end);
    } else if (m.code === 218) {
      if (!header) refused();
      scan(bytes, payload, end, header.components);
      entropy(bytes, end, restart);
      return Object.freeze(header.raster);
    } else if (m.code === 221) {
      if (length !== 4) refused();
      restart = word(bytes, payload);
    } else if (![196, 219, 254].includes(m.code) && !(m.code >= 224 && m.code <= 239)) refused();
    at = end;
  }
  return refused();
}
