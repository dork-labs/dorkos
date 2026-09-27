/**
 * Asset imports as the client's Vite build resolves them: `?url` gives the
 * asset's served URL (or an inline `data:` URL for a small file).
 */
declare module '*.svg?url' {
  const src: string;
  export default src;
}
