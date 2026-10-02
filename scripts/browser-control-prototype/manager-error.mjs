/** Fixed manager errors never retain page contents, URLs or Chromium stderr. */
export class BrowserManagerError extends Error {
  constructor(code) {
    super(`Managed browser: ${code}`);
    this.name = 'BrowserManagerError';
    this.code = code;
  }
}
