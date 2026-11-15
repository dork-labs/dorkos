/** CI-only preload for the overlay witness: the bridge calls the surface hook makes. */
import { contextBridge, ipcRenderer } from 'electron';

// The same literals the app's own preload sends (src/preload/index.ts). A sandboxed
// preload cannot load the bridge module, so the witness asserts they agree.
contextBridge.exposeInMainWorld('electronAPI', {
  localBrowser: {
    setBounds: (bounds: unknown) => ipcRenderer.invoke('local-browser:set-bounds', bounds),
    captureStill: (connectionId: string) =>
      ipcRenderer.invoke('local-browser:capture-still', connectionId),
  },
});
