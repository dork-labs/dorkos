/**
 * Shared doubles for the auto-updater suites.
 *
 * `vi.mock(..., factory)` memoizes its result for the whole test file, so mock
 * state is fetched through the real specifier (matching the pattern in
 * `index.test.ts`) rather than importing the mock modules directly. Each suite
 * still declares its own `vi.mock` calls; these only read them back.
 */
type ElectronMock = typeof import('./electron-mock');
type AutoUpdaterMock = typeof import('./electron-updater-mock');
type LogMock = typeof import('./electron-log-mock');

/** The mocked `electron` module. */
export async function getElectronMock(): Promise<ElectronMock> {
  const electron = await import('electron');
  return electron as unknown as ElectronMock;
}

/** The mocked `electron-updater` module. */
export async function getAutoUpdaterMock(): Promise<AutoUpdaterMock> {
  const electronUpdater = await import('electron-updater');
  return electronUpdater as unknown as AutoUpdaterMock;
}

/** The default electron-log double, standing in for `main.log`. */
export async function getMainLog(): Promise<LogMock['default']> {
  const electronLog = await import('electron-log');
  return (electronLog as unknown as LogMock).default;
}

/** The updater's own logger double (DOR-4847): where every updater line belongs. */
export async function getUpdaterLog(): Promise<LogMock['updaterLogDouble']> {
  const electronLog = await import('electron-log');
  return (electronLog as unknown as LogMock).updaterLogDouble;
}
