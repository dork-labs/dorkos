import type { OperatingSkill } from '../pack.js';

/** Teaches an agent to search, inspect, and install marketplace packages. */
export const usingTheMarketplace: OperatingSkill = {
  name: 'using-the-marketplace',
  description:
    'Use when finding, inspecting, installing, or removing a DorkOS marketplace package ' +
    '(agent, plugin, skill pack, or adapter), or managing marketplace sources. Covers search, ' +
    'the install confirmation flow, and listing what is installed.',
  body: `# Using the marketplace

The marketplace distributes installable packages: agents, plugins, skill packs,
and adapters. You can search it, inspect a package, and install or remove one.

## Find a package

- Search: \`marketplace_search\` with \`query\` (free text) and optional \`type\`
  (\`agent\`/\`plugin\`/\`skill-pack\`/\`adapter\`), \`category\`, \`tags\`, or \`marketplace\`.
- Recommend: \`marketplace_recommend\` with a context description
  (e.g. "I need to track errors in my Next.js app") returns ranked matches.
- Details: \`marketplace_get\` with a package \`name\` returns its manifest, README,
  and metadata.

## See what is installed

- Tool: \`marketplace_list_installed\` (filter by \`type\`). One entry per install
  across scopes, tagged \`global\` / \`agent-local\` / \`override\`.
- Sources: \`marketplace_list_marketplaces\` lists configured sources with their
  enabled flag and package counts.

## Install a package

### In-session (Claude Code): the confirmation flow

\`marketplace_install\` requires user confirmation and installs in two steps:

1. Call \`marketplace_install\` with the package \`name\`. It returns
   \`status: requires_confirmation\` and a \`confirmationToken\`.
2. Tell the user what will be installed and wait for them to approve in DorkOS.
   Then call \`marketplace_install\` again WITH the \`confirmationToken\` to complete.

Never skip the confirmation step — it is the trust boundary for putting code on
the user's machine.

### From the CLI (any runtime)

\`dorkos install <name> [--marketplace <name>] [--source <url>]\` installs against
the running server. Use \`--marketplace\` to disambiguate when several sources
carry the same package name, or \`--source\` for an explicit Git / marketplace.json
URL.

## Remove a package

- Tool: \`marketplace_uninstall\` (also confirmation-gated). By default it keeps
  \`.dork/data/\` and \`.dork/secrets.json\`; pass \`purge: true\` to remove them.
- CLI: \`dorkos uninstall <name>\`.

## Manage sources

- CLI: \`dorkos marketplace list|add|remove|refresh|validate\`. \`add\` registers a
  new marketplace source; \`refresh\` re-fetches its catalog; \`validate\` checks a
  source or package on disk.

## Scaffold your own package

\`marketplace_create_package\` scaffolds a new package under
\`~/.dork/personal-marketplace/packages/<name>/\` and registers it in the personal
marketplace. It is confirmation-gated. Publishing to a public marketplace is a
separate step that is not part of this flow.

## Rule

Installing, uninstalling, and scaffolding all change the user's system. State
plainly what you are about to do, get the confirmation the tool asks for, then
report what landed.`,
};
