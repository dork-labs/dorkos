/**
 * The palette's app commands (DOR-3970, spec §5): "Open Apps", and
 * "{App} settings" for every app, kept in step with the app list.
 *
 * Mounted once, by the app shell. It lives with the Apps page because the
 * palette is a feature and must not own the app list's queries. The apps
 * themselves are rows of their own (`use-palette-items`).
 *
 * @module widgets/apps-home/model/use-apps-palette
 */
import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAppActions, useAppCatalog, usePublishAppCatalog } from '@/layers/entities/extension';
import {
  registerPaletteCommandHandler,
  unregisterPaletteCommandHandler,
} from '@/layers/features/command-palette';
import { appRoutes } from '@/layers/shared/lib';
import { useExtensionRegistry } from '@/layers/shared/model';

/** The palette action Open Apps runs. */
const OPEN_APPS_ACTION = 'openApps';

/** The palette action one app's settings row runs. */
function appSettingsAction(id: string): string {
  return `appSettings:${id}`;
}

/** Keep the palette's Open Apps and per-app settings rows registered. */
export function useAppsPalette(): void {
  const navigate = useNavigate();
  const { openSettings } = useAppActions();
  const { apps } = useAppCatalog();
  // The palette reads the list from here rather than running the queries itself.
  usePublishAppCatalog(apps);

  useEffect(() => {
    registerPaletteCommandHandler(OPEN_APPS_ACTION, () => void navigate({ ...appRoutes.apps() }));
    const unregister = useExtensionRegistry.getState().register('command-palette.items', {
      id: 'open-apps',
      label: 'Open Apps',
      icon: 'LayoutGrid',
      action: OPEN_APPS_ACTION,
      category: 'quick-action',
      keywords: ['apps', 'mini apps', 'extensions', 'add-ons'],
    });
    return () => {
      unregister();
      unregisterPaletteCommandHandler(OPEN_APPS_ACTION);
    };
  }, [navigate]);

  useEffect(() => {
    const cleanups = apps.map((app) => {
      const action = appSettingsAction(app.id);
      registerPaletteCommandHandler(action, () => openSettings(app.id));
      const unregister = useExtensionRegistry.getState().register('command-palette.items', {
        id: `app-settings:${app.id}`,
        label: `${app.name} settings`,
        icon: 'Settings',
        action,
        category: 'feature',
        keywords: ['app', 'settings', app.name],
      });
      return () => {
        unregister();
        unregisterPaletteCommandHandler(action);
      };
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [apps, openSettings]);
}
