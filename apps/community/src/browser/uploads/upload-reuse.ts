/**
 * How long an uploaded file may still go with a message. The space refuses a file no message
 * took within an hour of its upload, so an older one is uploaded again rather than reused.
 */
export const UPLOAD_REUSE_MS = 30 * 60_000;

interface FileUpload {
  channelId: string;
  /** Kept until the upload lands, so a retry after a lost answer gets the same upload back. */
  key: string;
  attachmentId?: string;
  at?: number;
}

/**
 * Upload each file of a message at most once, while that upload is still usable (DOR-2835). A
 * message the space holds (a mute, slow mode, rules not accepted) stays in the message box with
 * its files, and sending it again, edited or not, attaches the uploads it already made.
 */
export function createUploadReuse(
  upload: (
    channelId: string,
    file: File,
    key: string,
    progress: (value: number) => void
  ) => Promise<string>,
  now: () => number = Date.now
) {
  const uploads = new WeakMap<File, FileUpload>();
  return {
    async attach(
      channelId: string,
      file: File,
      progress: (value: number) => void = () => undefined
    ): Promise<string> {
      let held = uploads.get(file);
      if (held?.channelId === channelId && held.attachmentId && now() - held.at! < UPLOAD_REUSE_MS)
        return held.attachmentId;
      if (!held || held.channelId !== channelId || held.attachmentId) {
        held = { channelId, key: crypto.randomUUID() };
        uploads.set(file, held);
      }
      const attachmentId = await upload(channelId, file, held.key, progress);
      Object.assign(held, { attachmentId, at: now() });
      return attachmentId;
    },
    /** A posted message's files belong to it now; none is reused. */
    forget(files: readonly File[]): void {
      for (const file of files) uploads.delete(file);
    },
  };
}
