import type {
  PrivateBrowserUploadOwner,
  PrivateBrowserUploadDispatcher,
  PrivateBrowserDownloadOwner,
  PrivateBrowserDownloadDispatcher,
  PrivateBrowserSemanticOwner,
  PrivateBrowserSemanticDispatcher,
} from '@dorkos/browser/server-owner';

/** Exact original constructor registrations retained before native birth; no request can create a slot. */
export function createPrivateCapabilitySlots() {
  let closed = false;
  let upload: PrivateBrowserUploadDispatcher | undefined;
  let download: PrivateBrowserDownloadDispatcher | undefined;
  let semantic: PrivateBrowserSemanticDispatcher | undefined;
  const check = () => {
    if (closed) throw new Error('BROWSER_CAPABILITY_CLOSED');
  };
  const uploadOwner: PrivateBrowserUploadOwner = Object.freeze({
    registerDispatcher(original: PrivateBrowserUploadDispatcher) {
      check();
      if (upload) throw new Error('BROWSER_CAPABILITY_REGISTERED');
      const dispatch = original.upload.bind(original);
      check();
      if (upload) throw new Error('BROWSER_CAPABILITY_REGISTERED');
      upload = Object.freeze({ upload: dispatch });
    },
  });
  const downloadOwner: PrivateBrowserDownloadOwner = Object.freeze({
    registerDispatcher(original: PrivateBrowserDownloadDispatcher) {
      check();
      if (download) throw new Error('BROWSER_CAPABILITY_REGISTERED');
      const dispatch = original.download.bind(original);
      check();
      if (download) throw new Error('BROWSER_CAPABILITY_REGISTERED');
      download = Object.freeze({ download: dispatch });
    },
  });
  const semanticOwner: PrivateBrowserSemanticOwner = Object.freeze({
    registerDispatcher(original: PrivateBrowserSemanticDispatcher) {
      check();
      if (semantic) throw new Error('BROWSER_CAPABILITY_REGISTERED');
      const read = original.read.bind(original);
      const resolve = original.resolve.bind(original);
      check();
      if (semantic) throw new Error('BROWSER_CAPABILITY_REGISTERED');
      const action = original.action.bind(original),
        openStream = original.openStream.bind(original);
      check();
      if (semantic) throw new Error('BROWSER_CAPABILITY_REGISTERED');
      semantic = Object.freeze({ read, resolve, action, openStream });
    },
  });
  return Object.freeze({
    uploadOwner,
    downloadOwner,
    semanticOwner,
    /** Capture all exact original registrations only after genuine engine construction settled. */
    capture() {
      check();
      if (!upload || !download || !semantic) throw new Error('BROWSER_CAPABILITY_MISSING');
      return Object.freeze({ upload, download, semantic });
    },
    close() {
      closed = true;
    },
  });
}
