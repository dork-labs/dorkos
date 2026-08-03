/**
 * What every attachment upload promises, whichever transport carries it.
 *
 * A leaf module on purpose: the in-process (Obsidian) transport reads these too,
 * and importing them through the HTTP transport's barrel would pull the whole
 * web stack into that bundle.
 *
 * @module shared/lib/transport/upload-contract
 */

/**
 * How long an upload may go completely silent before it is treated as dead.
 *
 * Measured from the last sign of life — a chunk of the body leaving, or a byte
 * of the response arriving — and NOT from the start of the request. A total
 * deadline is the wrong shape here: a 200 MB file over a hotel connection is
 * slow but healthy, and killing it at any fixed duration punishes the person
 * for their upload being big. Silence is the signal that the connection is
 * gone, and it does not get more truthful the longer the file is.
 *
 * Thirty seconds matches the total budget `fetchJSON` gives an ordinary API
 * call, which is the longest this app is ever willing to wait on a server that
 * has said nothing at all.
 */
export const UPLOAD_STALL_TIMEOUT_MS = 30_000;

/** Shown on the attachment chip when an upload goes quiet for {@link UPLOAD_STALL_TIMEOUT_MS}. */
export const UPLOAD_STALLED_MESSAGE = 'The upload stopped responding';

/** Shown on the attachment chip when someone cancels an upload that was still running. */
export const UPLOAD_CANCELED_MESSAGE = 'Upload canceled';

/**
 * Shown when the upload got a 2xx that did not come from DorkOS.
 *
 * A proxy interstitial, a captive portal or an expired-session redirect all
 * answer 200 with HTML. Naming it as a reply problem points at the thing a
 * person can actually do something about — the network they are on, or a
 * sign-in that has lapsed — rather than blaming their file.
 */
export const UPLOAD_UNREADABLE_MESSAGE = 'The upload got an unexpected reply';
