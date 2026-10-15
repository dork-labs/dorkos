import type { UploadFile } from '@dorkos/shared/transport';

/** Create an upload descriptor whose array buffer contains a detached copy of the supplied bytes. */
export function bytesFile(name: string, type: string, bytes: Uint8Array): UploadFile {
  const buffer = bytes.slice().buffer;
  return { name, type, size: bytes.byteLength, arrayBuffer: async () => buffer };
}
/** Decode a data URL payload from base64 into bytes for the devtools media upload. */
export function pngBytes(dataUrl: string): Uint8Array {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
