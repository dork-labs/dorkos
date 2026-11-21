/** Server-owned context shown on package cards when the request is made. */
export function withOutsideWordsNote(summary: string, outsideWords: boolean | undefined): string {
  return outsideWords ? `This request followed words from outside your team.\n${summary}` : summary;
}
