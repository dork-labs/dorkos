import { create } from 'zustand';

/**
 * Saving a file an app made (DOR-3293). The frame has no `allow-downloads`, so
 * `api.download(name, mimeType, data)` asks the host. DorkOS checks the file,
 * asks the person in its own dialog (`AppDownloadPrompt`), and only then saves
 * it, always as a plain download that is never opened.
 *
 * @module features/extensions/frame/download
 */

/** The largest file an app may offer to save: 10 MB. */
export const APP_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** The kinds of file an app may save. Anything else is refused before any prompt. */
export const APP_DOWNLOAD_MIME_TYPES = new Set([
  'application/json',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

/**
 * Names an app may never save: they run, install or open on their own when
 * clicked (Security, 2026-11-10). Compared against the final extension.
 */
const REFUSED_EXTENSIONS = new Set([
  'app',
  'command',
  'sh',
  'pkg',
  'dmg',
  'exe',
  'bat',
  'ps1',
  'html',
  'htm',
  'svg',
  'webloc',
  'terminal',
]);

/** Control characters and the bidi overrides that can disguise a name's real extension. */
const UNSAFE_CHARS = new RegExp(
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this removes.
  '[\\u0000-\\u001f\\u007f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]',
  'g'
);

/**
 * Reduce an app's suggested filename to a bare, safe name, or `null` when the
 * name is one an app may not save.
 *
 * @param raw - The name the app asked for.
 * @returns A name with no path, no control or bidi characters and no leading
 *   dot, at most 120 characters; `null` for a refused extension.
 */
export function safeDownloadName(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(UNSAFE_CHARS, '').trim().replace(/^\.+/, '').slice(0, 120);
  const name = cleaned === '' ? 'download' : cleaned;
  const dot = name.lastIndexOf('.');
  const extension = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  return REFUSED_EXTENSIONS.has(extension) ? null : name;
}

/** What the save prompt shows and how it answers. */
export interface PendingAppDownload {
  /** The app's name, from DorkOS's records. */
  appName: string;
  /** The checked filename. */
  name: string;
  /** The file's size in bytes. */
  size: number;
  /** Save or cancel. */
  answer: (save: boolean) => void;
}

/** The one save prompt waiting for the person, if any. */
export const useAppDownloadPrompt = create<{ pending: PendingAppDownload | null }>(() => ({
  pending: null,
}));

/**
 * Offer to save a file an app made.
 *
 * Refused before any prompt, so the person sees nothing: a type off the list,
 * a refused name, a file over {@link APP_DOWNLOAD_MAX_BYTES}, or a second
 * offer while one is open.
 *
 * @param appName - The app's name, from DorkOS's records, never from the app.
 * @param name - The filename the app suggests.
 * @param mimeType - What kind of file it is.
 * @param data - Its contents.
 * @returns `saved` when the person chose Save, `cancelled` otherwise.
 * @throws When the file is refused.
 */
export function offerAppDownload(
  appName: string,
  name: string,
  mimeType: string,
  data: string | ArrayBuffer | Blob
): Promise<'saved' | 'cancelled'> {
  if (!APP_DOWNLOAD_MIME_TYPES.has(mimeType))
    throw new Error('Apps cannot save that kind of file.');
  const safeName = safeDownloadName(name);
  if (safeName === null) throw new Error('Apps cannot save that kind of file.');
  // Saved as a plain download whatever the type says, so it is never opened inline.
  const blob = new Blob([data], { type: 'application/octet-stream' });
  if (blob.size > APP_DOWNLOAD_MAX_BYTES) throw new Error('That file is too big to save.');
  if (useAppDownloadPrompt.getState().pending) {
    throw new Error('Another save is waiting for an answer.');
  }
  return new Promise((resolve) => {
    useAppDownloadPrompt.setState({
      pending: {
        appName,
        name: safeName,
        size: blob.size,
        answer: (save) => {
          // The dialog can answer twice (a button, then its close); only the first counts.
          if (useAppDownloadPrompt.getState().pending === null) return;
          useAppDownloadPrompt.setState({ pending: null });
          if (save) saveBlob(blob, safeName);
          resolve(save ? 'saved' : 'cancelled');
        },
      },
    });
  });
}

/** Hand a file to the browser's download, by a link that names it. */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * A filename cut in the middle so its extension always shows:
 * `people-ex…port.json`.
 *
 * @param name - The filename.
 * @param max - The most characters to show.
 */
export function middleTruncate(name: string, max = 28): string {
  if (name.length <= max) return name;
  const tail = Math.ceil((max - 1) / 2);
  return `${name.slice(0, max - 1 - tail)}…${name.slice(-tail)}`;
}

/**
 * A file size in the person's terms: `512 B`, `24 KB`, `3.1 MB`.
 *
 * @param bytes - The size in bytes.
 */
export function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
