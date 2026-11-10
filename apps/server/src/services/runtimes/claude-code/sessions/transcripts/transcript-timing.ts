/** Parse only a recorded JSONL timestamp; never substitute the current time. */
export function epochMs(timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? undefined : ms;
}
