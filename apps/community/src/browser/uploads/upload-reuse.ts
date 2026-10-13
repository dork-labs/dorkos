/**
 * How long an uploaded file may still go with a message. The space refuses a file no message
 * took within an hour of its upload, so an older one is uploaded again rather than reused.
 */
export const UPLOAD_REUSE_MS = 30 * 60_000;

interface FileUpload {
  channelId: string;
  /** Kept until the upload lands, so a retry after a lost answer gets the same upload back. */
  key: string;
  /** When this key was first tried, never later than the space's own record of the upload. */
  at: number;
  attachmentId?: string;
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
      progress: (value: number) => void = () => undefined,
      /**
       * Set when retrying a post whose answer was lost: its key names these exact files, so they
       * go again however old, and a post that landed answers with its entry, never a conflict.
       */
      keepOld = false
    ): Promise<string> {
      let held = uploads.get(file);
      if (
        held?.channelId === channelId &&
        held.attachmentId &&
        (keepOld || now() - held.at < UPLOAD_REUSE_MS)
      )
        return held.attachmentId;
      if (!held || held.channelId !== channelId || held.attachmentId) {
        held = { channelId, key: crypto.randomUUID(), at: now() };
        uploads.set(file, held);
      }
      held.attachmentId = await upload(channelId, file, held.key, progress);
      return held.attachmentId;
    },
    /** A posted message's files belong to it now; none is reused. */
    forget(files: readonly File[]): void {
      for (const file of files) uploads.delete(file);
    },
  };
}
