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
import { useExtensionRegistry, type CommandPaletteContribution } from '@/layers/shared/model';

/** The palette action Open Apps runs. */
const OPEN_APPS_ACTION = 'openApps';

/** The palette action one app's settings row runs. */
function appSettingsAction(id: string): string {
  return `appSettings:${id}`;
}

/**
 * One app's "{App} settings" palette row.
 *
 * No "settings" keyword: that word belongs to the plain Settings row. With
 * it, every app's row tied that one for "settings", the tie went to the
 * lower id, and ⌘K, "settings", Enter opened the first app's Settings row.
 * The label still carries the word, so the rows come up, just below it.
 *
 * @param app - The app's id and name.
 * @internal Exported for testing only.
 */
export function appSettingsPaletteRow(app: {
  id: string;
  name: string;
}): CommandPaletteContribution {
  return {
    id: `app-settings:${app.id}`,
    label: `${app.name} settings`,
    icon: 'Settings',
    action: appSettingsAction(app.id),
    category: 'feature',
  };
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
      const row = appSettingsPaletteRow(app);
      const action = row.action;
      registerPaletteCommandHandler(action, () => openSettings(app.id));
      const unregister = useExtensionRegistry.getState().register('command-palette.items', row);
      return () => {
        unregister();
        unregisterPaletteCommandHandler(action);
      };
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [apps, openSettings]);
}
