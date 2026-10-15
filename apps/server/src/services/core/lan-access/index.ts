/**
 * Wi-Fi access (DOR-2930): the one controller this server runs, wired to the
 * real settings, login posture and network. See `lan-access.ts`.
 *
 * @module services/core/lan-access
 */
import { env, hostFromEnvironment } from '../../../env.js';
import { AUTH_COOKIES_SECURE } from '../auth/index.js';
import { canExpose } from '../auth/exposure-guard.js';
import { configManager } from '../config-manager.js';
import { logConfigWrite } from '../operator/config-write.js';
import { LanAccess } from './lan-access.js';
import { isLocalNetworkPeer, readLanAddresses, readLocalName } from './lan-addresses.js';

export {
  LanAccess,
  LAN_ACCESS_UNSUPPORTED_MESSAGE,
  type LanAccessDeps,
  type LanListenerSource,
} from './lan-access.js';
export { getLanAccessHosts, getLanAccessOrigins } from './lan-trust.js';

/**
 * Write the `server.lanAccess` setting, with the audit line every purpose-built
 * writer leaves. The controller follows the write on its own.
 *
 * @param enabled - The new value.
 */
export function writeLanAccessSetting(enabled: boolean): void {
  const before = configManager.get('server');
  configManager.set('server', { ...before, lanAccess: enabled });
  logConfigWrite('Wi-Fi access', 'server', before, configManager.get('server'));
}

/**
 * The environment setting that decides where DorkOS listens in place of the
 * switch, or `null`. `DORKOS_ALLOW_INSECURE_BIND` counts too: it makes every
 * peer local (`isLocalRequest`), so a phone would be treated as this computer.
 */
export function lanAccessEnvironmentLock(): string | null {
  if (hostFromEnvironment !== null) return `DORKOS_HOST=${hostFromEnvironment}`;
  return env.DORKOS_ALLOW_INSECURE_BIND ? 'DORKOS_ALLOW_INSECURE_BIND' : null;
}

/** The server's Wi-Fi access controller. `index.ts` attaches it once listening. */
export const lanAccess = new LanAccess({
  readSetting: () => configManager.get('server')?.lanAccess === true,
  writeSetting: writeLanAccessSetting,
  canExpose,
  setByEnvironment: lanAccessEnvironmentLock,
  isLocalPeer: (address) => isLocalNetworkPeer(address),
  secureCookies: AUTH_COOKIES_SECURE,
  readLocalName: () => readLocalName(),
  readAddresses: () => readLanAddresses(),
  onSettingsChange: (listener) => configManager.onChange((change) => listener(change.sections)),
});
