/** Bound MCP work before schema validation (GHSA-46jr-4wx8-v453). */
export const MCP_SERVER_OPTIONS = { maxToolInputElements: 10_000 } as const;

/** Matches the existing 1 MiB JSON parser cap, including unparsed transport bodies. */
export const MCP_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
