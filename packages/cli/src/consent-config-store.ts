/**
 * Open the person's config for a CLI verb that records a consent decision
 * (`harness sync --allow-hooks`, `harness hooks --revoke`, `harness global`),
 * and hand the server's consent door a store over it (spec
 * `computer-side-starts-alone` §5.7). The door writes `harness` and
 * `permissions` only through a store it is handed, and refuses every write
 * without one.
 *
 * @module consent-config-store
 */

/**
 * Open `config.json` in `dorkHome` and wire the consent door to it.
 *
 * @param dorkHome - The resolved DorkOS data directory.
 */
export async function openConsentConfig(dorkHome: string): Promise<void> {
  const { initConfigManager } = await import('../server/services/core/config-manager.js');
  const { logConfigWrite } = await import('../server/services/core/operator/config-write.js');
  const { setConsentConfigStore } =
    await import('../server/services/core/approvals/computer-asks/consent-config.js');
  const config = initConfigManager(dorkHome);
  setConsentConfigStore({
    get: (section) => config.get(section),
    set: (section, value) => config.set(section, value),
    logWrite: (reason, section, before, after) => logConfigWrite(reason, section, before, after),
  });
}
