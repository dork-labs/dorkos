import { app } from 'electron';
import { COPYRIGHT_NOTICE } from '@dorkos/shared/company';

/**
 * Configure the native "About DorkOS" panel (App menu → About DorkOS, `role: 'about'`).
 *
 * Must be called once during startup, before the panel can be shown — Electron
 * reads these options lazily when the panel is opened, so there is no
 * ordering dependency with menu setup beyond "before the user can click it".
 */
export function setupAboutPanel(): void {
  app.setAboutPanelOptions({
    applicationName: 'DorkOS',
    applicationVersion: app.getVersion(),
    copyright: COPYRIGHT_NOTICE,
    credits: 'All your coding agents. One place.',
  });
}
