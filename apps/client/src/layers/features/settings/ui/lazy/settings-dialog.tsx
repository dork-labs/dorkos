/**
 * Settings, fetched when it is first wanted instead of with the app (DOR-2901).
 *
 * Settings is one of the largest parts of the app (every tab, the runtime
 * cards, the trust dial) and most visits never open it. The barrel exports
 * this stand-in under the dialog's own name, so it renders nothing until first
 * opened: a test of the barrel's export finds the dialog with `findBy`, not
 * `getBy`. Tests of the dialog itself import it from `../SettingsDialog`.
 *
 * @module features/settings/ui/lazy/settings-dialog
 */
import { lazyDialog } from '@/layers/shared/ui/lazy/lazy-dialog';

/** The tabbed Settings dialog, loaded the first time it opens. */
export const SettingsDialog = lazyDialog('SettingsDialog', () =>
  import('../SettingsDialog').then((module) => module.SettingsDialog)
);
