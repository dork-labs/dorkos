import type { OwnedBrowserController } from '../api/controller.js';
import type { BrowserLifecycleEngine } from '@dorkos/browser/server-owner';
import type { BrowserControllerIdentities } from '../api/controller-auth.js';
import type { BrowserControllerHost } from '../api/controller-host.js';
import type { OwnedBrowserGrants } from '../api/grants.js';
import { BrowserUploadArtifacts } from '../api/files/upload-artifacts.js';
import { BrowserControllerUpload } from '../api/controller-upload.js';
import { BrowserHumanFileRoutes } from '../api/human-file-routes.js';
import { BrowserControllerDownload } from '../api/controller-download.js';
import { BrowserSemanticRoutes } from '../api/semantic-routes.js';
import { BrowserSemanticReadHost } from '../api/semantic-read-host.js';
import { BrowserDiagnosticsHost } from '../api/diagnostics-host.js';
import { BrowserDiagnosticsRoutes } from '../api/diagnostics-routes.js';
import type { createPrivateCapabilitySlots } from './private-capability-slots.js';

/** Constructor-private capability composition. No request body can supply participants or staging paths. */
type CapabilityOptions = {
  engine: BrowserLifecycleEngine;
  identities: BrowserControllerIdentities;
  grants: OwnedBrowserGrants;
  controller: BrowserControllerHost;
  semanticController: OwnedBrowserController;
  slots: ReturnType<typeof createPrivateCapabilitySlots>;
  enabled(): boolean;
  artifactDirectory: string;
  protectedRoots: readonly string[];
};

/** Retain authenticated file capabilities and join their original work during teardown. */
export function createAuthenticatedBrowserCapabilities() {
  const originals: (() => unknown | Promise<unknown>)[] = [];
  let closed = false;
  let closing: Promise<void> | undefined;
  let opening: Promise<unknown> | undefined;
  let first: Readonly<{ value: unknown }> | undefined;
  const fail = (value: unknown) => {
    first ??= Object.freeze({ value });
  };
  // The owner is formed before entering constructors/getters; every original close is captured immediately.
  const closedOriginals = new Set<() => unknown | Promise<unknown>>();
  const pendingClose = new Set<Promise<unknown>>();
  const enterClose = () => {
    for (const original of originals) {
      if (closedOriginals.has(original)) continue;
      closedOriginals.add(original);
      let done!: (value: unknown) => void, rejected!: (value: unknown) => void;
      const job = new Promise<unknown>((resolve, reject) => {
        done = resolve;
        rejected = reject;
      });
      pendingClose.add(job);
      void job.then(
        () => pendingClose.delete(job),
        (value) => {
          fail(value);
          pendingClose.delete(job);
        }
      );
      try {
        Promise.resolve(original()).then(done, rejected);
      } catch (value) {
        rejected(value);
      }
    }
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    let done!: () => void, rejected!: (value: unknown) => void;
    closing = new Promise<void>((resolve, reject) => {
      done = resolve;
      rejected = reject;
    });
    closed = true;
    enterClose();
    void Promise.resolve()
      .then(async () => {
        if (opening) await Promise.allSettled([opening]);
        enterClose();
        while (pendingClose.size) await Promise.allSettled([...pendingClose]);
        if (first) throw first.value;
      })
      .then(done, rejected);
    return closing;
  };
  const retain = (owner: { close(): unknown | Promise<unknown> }) => {
    const original = owner.close.bind(owner);
    originals.push(original);
    if (closed) {
      enterClose();
      throw new Error('BROWSER_CAPABILITY_CLOSED');
    }
  };
  return Object.freeze({
    close,
    open(options: CapabilityOptions) {
      if (closed || opening) throw new Error('BROWSER_CAPABILITY_CLOSED');
      // Register the whole operation before any participant getter/constructor can reenter close.
      const operation = Promise.resolve().then(() => {
        try {
          const engine = options.engine,
            identities = options.identities,
            grants = options.grants,
            controller = options.controller,
            semanticController = options.semanticController,
            slots = options.slots,
            artifactDirectory = options.artifactDirectory,
            protectedRoots = Object.freeze([...options.protectedRoots]);
          const enabled = options.enabled.bind(options);
          const check = () => {
            if (closed || !enabled() || closed) throw new Error('BROWSER_CAPABILITY_CLOSED');
          };
          check();
          const captureSlots = slots.capture.bind(slots);
          check();
          const captured = captureSlots();
          check();
          const artifacts = new BrowserUploadArtifacts(artifactDirectory, protectedRoots);
          retain(artifacts);
          check();
          const upload = new BrowserControllerUpload(artifacts, identities, grants, enabled);
          retain(upload);
          check();
          upload.owner.registerDispatcher(captured.upload);
          check();
          upload.bindHost(controller);
          check();
          const download = new BrowserControllerDownload(artifacts, identities, grants, enabled);
          retain(download);
          check();
          download.owner.registerDispatcher(captured.download);
          check();
          download.bindHost(controller);
          check();
          const fileRoutes = new BrowserHumanFileRoutes(
            upload,
            download,
            artifacts,
            identities,
            grants,
            enabled
          );
          retain(fileRoutes);
          check();
          const semantic = new BrowserSemanticReadHost(
            identities,
            grants,
            enabled,
            semanticController
          );
          retain(semantic);
          check();
          semantic.registerDispatcher(captured.semantic);
          check();
          const semanticRoutes = new BrowserSemanticRoutes(semantic);
          retain(semanticRoutes);
          check();
          const diagnostics = new BrowserDiagnosticsHost(engine, grants, identities, enabled);
          retain(diagnostics);
          check();
          const diagnosticsRoutes = new BrowserDiagnosticsRoutes(diagnostics);
          retain(diagnosticsRoutes);
          check();
          return Object.freeze({
            fileRouter: fileRoutes.router,
            semanticRouter: semanticRoutes.router,
            diagnosticsRouter: diagnosticsRoutes.router,
            upload: upload.upload.bind(upload),
            stageForActor: upload.stageForActor.bind(upload),
            uploadForActor: upload.uploadForActor.bind(upload),
            downloadForActor: download.downloadForActor.bind(download),
            download: download.download.bind(download),
            readSemantic: semantic.read.bind(semantic),
            resolveSemantic: semantic.resolve.bind(semantic),
            streamSemantic: semantic.stream.bind(semantic),
            actionSemantic: semantic.action.bind(semantic),
            readSemanticForActor: semantic.readForActor.bind(semantic),
            resolveSemanticForActor: semantic.resolveForActor.bind(semantic),
            streamSemanticForActor: semantic.streamForActor.bind(semantic),
            actionSemanticForActor: semantic.actionForActor.bind(semantic),
            diagnostics: diagnostics.capture.bind(diagnostics),
            close,
          });
        } catch (value) {
          fail(value);
          void close().catch(() => {});
          throw value;
        }
      });
      opening = operation;
      return operation;
    },
  });
}
