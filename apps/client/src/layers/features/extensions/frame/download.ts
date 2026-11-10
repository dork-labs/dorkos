import { toast } from 'sonner';

/** The largest file an app may offer to save: 10 MB of content. */
export const APP_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Types an app may never save: they run, install or open on their own when
 * clicked (Security, 2026-11-10). Compared against the final extension only.
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
 * type is one an app may not save.
 *
 * @param raw - The name the app asked for.
 * @returns A name with no path, no control or bidi characters and no leading
 *   dot, at most 120 characters; `null` for a refused type.
 */
export function safeDownloadName(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(UNSAFE_CHARS, '').trim().replace(/^\.+/, '').slice(0, 120);
  const name = cleaned === '' ? 'download' : cleaned;
  const dot = name.lastIndexOf('.');
  const extension = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  return REFUSED_EXTENSIONS.has(extension) ? null : name;
}

/** What an app asks to save: a name and its text content. */
export interface AppDownloadRequest {
  name: string;
  content: string;
}

let pending = false;

/**
 * Offer to save a file an app made. The person confirms in a toast DorkOS
 * draws, never inside the app's frame; the file is always saved as a plain
 * download (`application/octet-stream`), never opened. One offer at a time.
 *
 * @param appName - The app's name, shown in the offer.
 * @param request - The file the app wants saved.
 * @returns `saved` when the person chose Save, `dismissed` otherwise.
 * @throws When the name's type is refused, the file is too big, or another offer is open.
 */
export function offerAppDownload(
  appName: string,
  request: AppDownloadRequest
): Promise<'saved' | 'dismissed'> {
  const name = safeDownloadName(request.name);
  if (name === null) throw new Error('Apps cannot save that type of file.');
  const blob = new Blob([request.content], { type: 'application/octet-stream' });
  if (blob.size > APP_DOWNLOAD_MAX_BYTES) throw new Error('That file is too big to save.');
  if (pending) throw new Error('Another save is waiting for an answer.');
  pending = true;
  return new Promise((resolve) => {
    let saved = false;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      pending = false;
      resolve(saved ? 'saved' : 'dismissed');
    };
    toast(`${appName} wants to save ${name}`, {
      duration: 30_000,
      action: {
        label: 'Save',
        onClick: () => {
          saved = true;
          saveBlob(blob, name);
          settle();
        },
      },
      onDismiss: settle,
      onAutoClose: settle,
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
