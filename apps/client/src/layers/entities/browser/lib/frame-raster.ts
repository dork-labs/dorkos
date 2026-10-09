const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION = 16384;
const MAX_PIXELS = 8 * 1024 * 1024;
/** Copied header dimensions; this is not decoded content or producer allocation proof. */
export interface JpegRaster {
  readonly width: number;
  readonly height: number;
  readonly format: 'jpeg';
}
/** Client encoded-raster preflight, separate from any server authorization or decoder proof. */
export class BrowserFrameRasterRefusal extends Error {
  constructor(readonly reason: 'header' | 'budget') {
    super(reason);
  }
}
function refused(reason: 'header' | 'budget' = 'header'): never {
  throw new BrowserFrameRasterRefusal(reason);
}
function word(bytes: Uint8Array, at: number): number {
  if (at + 1 >= bytes.length) refused();
  return bytes[at] * 256 + bytes[at + 1];
}
function marker(bytes: Uint8Array, at: number): { code: number; next: number } {
  if (bytes[at++] !== 255) refused();
  while (bytes[at] === 255) at++;
  if (at >= bytes.length) refused();
  return { code: bytes[at], next: at + 1 };
}
function frame(
  bytes: Uint8Array,
  at: number,
  end: number
): { raster: JpegRaster; components: Set<number> } {
  const height = word(bytes, at + 1),
    width = word(bytes, at + 3),
    count = bytes[at + 5];
  if (
    bytes[at] !== 8 ||
    ![1, 3].includes(count) ||
    end - at !== 6 + 3 * count ||
    width < 1 ||
    height < 1
  )
    refused();
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS)
    refused('budget');
  const components = new Set<number>();
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
function scan(bytes: Uint8Array, at: number, end: number, components: Set<number>): void {
  const count = bytes[at];
  if (count !== components.size || end - at !== 1 + 2 * count + 3) refused();
  const seen = new Set<number>();
  for (let i = 0; i < count; i++) {
    const id = bytes[at + 1 + 2 * i],
      tables = bytes[at + 2 + 2 * i];
    if (!components.has(id) || seen.has(id) || tables >> 4 > 3 || (tables & 15) > 3) refused();
    seen.add(id);
  }
  if (bytes[end - 3] !== 0 || bytes[end - 2] !== 63 || bytes[end - 1] !== 0) refused();
}
function entropy(bytes: Uint8Array, at: number, restart: number): void {
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
function readJpegRaster(bytes: Uint8Array): JpegRaster {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BYTES || word(bytes, 0) !== 65496)
    refused();
  let at = 2,
    restart = 0;
  let header: ReturnType<typeof frame> | undefined;
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

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
function uint32(bytes: Uint8Array, at: number): number {
  if (at + 3 >= bytes.length) refused();
  return bytes[at] * 0x1000000 + bytes[at + 1] * 0x10000 + bytes[at + 2] * 0x100 + bytes[at + 3];
}
// Fixed polynomial table bounds checksum work to one lookup per encoded byte.
const crcTable = Object.freeze(
  Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    return crc >>> 0;
  })
);
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

/** Narrow screenshot PNG: 8-bit RGB/RGBA, noninterlaced, no compressed metadata/APNG. */
function readPngRaster(bytes: Uint8Array) {
  if (bytes.length < 45 || !pngSignature.every((value, i) => bytes[i] === value)) refused();
  let at = 8,
    width = 0,
    height = 0,
    data = false;
  const ancillary = new Set<string>();
  while (at < bytes.length) {
    const length = uint32(bytes, at),
      payload = at + 8,
      end = payload + length;
    if (end + 4 > bytes.length) refused();
    const kind = String.fromCharCode(...bytes.subarray(at + 4, payload));
    if (at === 8) {
      if (kind !== 'IHDR' || length !== 13) refused();
      width = uint32(bytes, payload);
      height = uint32(bytes, payload + 4);
      if (
        width < 1 ||
        height < 1 ||
        width > MAX_DIMENSION ||
        height > MAX_DIMENSION ||
        width * height > MAX_PIXELS
      )
        refused('budget');
      if (
        bytes[payload + 8] !== 8 ||
        ![2, 6].includes(bytes[payload + 9]) ||
        bytes[payload + 10] !== 0 ||
        bytes[payload + 11] !== 0 ||
        bytes[payload + 12] !== 0
      )
        refused();
    } else if (kind === 'IDAT') {
      if (length === 0) refused();
      data = true;
    } else if (kind === 'IEND') {
      if (!data || length !== 0 || end + 4 !== bytes.length) refused();
    } else {
      if (data || ancillary.has(kind)) refused();
      ancillary.add(kind);
      // Fixed-size screenshot color hints cannot request auxiliary decompression/allocation.
      if (kind === 'sRGB') {
        if (length !== 1 || bytes[payload] > 3) refused();
      } else if (kind === 'gAMA') {
        if (length !== 4 || uint32(bytes, payload) === 0) refused();
      } else if (kind === 'cHRM') {
        if (length !== 32) refused();
      } else refused();
    }
    if (uint32(bytes, end) !== crc32(bytes, at + 4, end)) refused();
    if (kind === 'IEND') return Object.freeze({ width, height, format: 'png' as const });
    at = end + 4;
  }
  return refused();
}

/** Bound encoded headers and decoded raster area BEFORE original HTMLImageElement.decode. */
export function inspectBrowserFrameRaster(bytes: Uint8Array, format: 'jpeg' | 'png') {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) refused('budget');
  if (format !== 'jpeg' && format !== 'png') refused();
  return format === 'jpeg' ? readJpegRaster(bytes) : readPngRaster(bytes);
}
