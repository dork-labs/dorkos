/**
 * Read-only grants for the packages a person installed globally, so an OpenCode
 * turn can read them without a prompt (DOR-4386).
 *
 * A globally installed package (Flow, say) lives in `<dorkHome>/plugins/<name>`,
 * outside every project, and its skills link to it. OpenCode raises
 * `external_directory` whenever a tool reaches there, and a headless run
 * (`opencode run`, a schedule) has nobody to answer, so the read is refused and
 * the agent cannot read its own installed skill.
 *
 * Security's ruling: grant each package's OWN folder, by its exact real path,
 * read-only. Never the plugins folder itself (a package DorkOS does not point
 * OpenCode at, or a backup an install left beside one, stays ungranted), and
 * never anything writable: a
 * write inside a `read` grant is refused in every mode, Full included
 * (`directory-grants.ts`). Packages stay outside the project, where an agent
 * could otherwise edit the rules that guard it.
 *
 * Read fresh on every ask, so an install or uninstall takes effect on the very
 * next one, and nothing is left behind in the sidecar.
 *
 * @module services/runtimes/opencode/messaging/package-grants
 */
import { realpathSync } from 'node:fs';
import { PROJECTABLE_PLUGIN_TYPES, scanInstalledSources } from '@dorkos/harness';
import type { DirectoryGrant } from '@dorkos/shared/agent-runtime';

/**
 * One read-only grant per globally installed package, at its real folder.
 *
 * Never throws: a data directory that cannot be scanned grants nothing, and the
 * ask falls to the session's mode exactly as before.
 *
 * @param dorkHome - The resolved DorkOS data directory.
 */
export function installedPackageReadGrants(dorkHome: string): DirectoryGrant[] {
  let plugins;
  try {
    plugins = scanInstalledSources({ dorkHome }).plugins;
  } catch {
    return [];
  }
  const grants: DirectoryGrant[] = [];
  for (const plugin of plugins) {
    if (plugin.location.scope !== 'global') continue;
    // Only a package DorkOS points OpenCode at: a type whose skills and
    // commands it projects, shipping at least one. Any other package beside
    // it (an adapter, an agent's files) stays ungranted.
    if (!PROJECTABLE_PLUGIN_TYPES.has(plugin.type)) continue;
    if (plugin.skills.length === 0 && plugin.commands.length === 0) continue;
    try {
      grants.push({ path: realpathSync(plugin.location.absDir), access: 'read' });
    } catch {
      // Gone between the scan and the realpath: nothing to grant.
    }
  }
  return grants;
}
