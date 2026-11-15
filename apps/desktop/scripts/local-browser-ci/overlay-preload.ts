/** CI-only preload for the overlay witness: the one bridge call the surface hook makes. */
import { contextBridge, ipcRenderer } from 'electron';

// The same literal the app's own preload sends (src/preload/index.ts). A sandboxed
// preload cannot load the bridge module, so the witness asserts the two agree.
contextBridge.exposeInMainWorld('electronAPI', {
  localBrowser: {
    setBounds: (bounds: unknown) => ipcRenderer.invoke('local-browser:set-bounds', bounds),
  },
});
