/**
 * Asset imports as the client's Vite build resolves them: `?url` gives the
 * asset's served URL (or an inline `data:` URL for a small file).
 */
declare module '*.svg?url' {
  const src: string;
  export default src;
}

/** See the `*.svg?url` declaration above. */
declare module '*.png?url' {
  const src: string;
  export default src;
}
