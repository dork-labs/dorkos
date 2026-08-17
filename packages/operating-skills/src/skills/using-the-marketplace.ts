import type { OperatingSkill } from '../pack.js';
import { TOOL_NAME_NOTE } from '../tool-name-note.js';

/** Teaches an agent to search, inspect, and install marketplace packages. */
export const usingTheMarketplace: OperatingSkill = {
  name: 'using-the-marketplace',
  description:
    'Use when finding, inspecting, installing, or removing a DorkOS marketplace package ' +
    '(agent, plugin, skill pack, or adapter), or reading marketplace sources. Covers search, ' +
    'the install confirmation flow, the uninstall approval flow, listing what is installed, and ' +
    'why only a person may add or remove a source.',
  body: `# Using the marketplace

${TOOL_NAME_NOTE}

The marketplace distributes installable packages: agents, plugins, skill packs,
and adapters. You can search it, inspect a package, and install or remove one.

Every operation here is a capability, so each one is also reachable by id with
\`dorkos call marketplace.<verb> --input '<json>'\` from any runtime. Run
\`dorkos capabilities\` for the live list and each entry's tier.

## Find a package (tier: observe)

- Search: \`marketplace_search\` with \`query\` (free text) and optional \`type\`
  (\`agent\`/\`plugin\`/\`skill-pack\`/\`adapter\`), \`category\`, \`tags\`, or \`marketplace\`.
- Recommend: \`marketplace_recommend\` with a context description
  (e.g. "I need to track errors in my Next.js app") returns ranked matches.
- Details: \`marketplace_get\` with a package \`name\` returns its manifest, README,
  and metadata.

## See what is installed (tier: observe)

- Tool: \`marketplace_list_installed\` (filter by \`type\`). One entry per install
  across scopes, tagged \`global\` / \`agent-local\` / \`override\`.
- Sources: \`marketplace_list_marketplaces\` lists configured sources with their
  enabled flag and package counts.

## Install a package (tier: act)

### In-session: the confirmation flow

\`marketplace_install\` runs its own confirmation handshake, which is NOT the
approval flow described in operating-dorkos. Watch for these exact field names:

1. Call \`marketplace_install\` with the package \`name\`. It returns
   \`status: requires_confirmation\` and a \`confirmationToken\`.
2. Tell the user what will be installed and wait for them to approve in DorkOS.
   Then call \`marketplace_install\` again WITH the \`confirmationToken\` to complete.

Never skip the confirmation step. It is the trust boundary for putting code on
the user's machine.

\`marketplace_create_package\` (below) uses the same \`confirmationToken\` handshake.

### From the CLI (any runtime)

\`dorkos install <name> [--marketplace <name>] [--source <url>]\` installs against
the running server. Use \`--marketplace\` to disambiguate when several sources
carry the same package name, or \`--source\` for an explicit Git / marketplace.json
URL.

## Remove a package (tier: destructive)

Removing a package cannot be undone, so it is gated on a person's approval and
returns the APPROVAL payload, not a \`confirmationToken\`. Two gated paths, pick the
one your session has:

- **In-session tool:** \`marketplace_uninstall\`, retried with an \`approvalToken\`
  argument.
- **Any runtime, from a shell:** \`dorkos call marketplace.uninstall --input
  '{"name":"<pkg>"}'\`, retried with \`--approval <token>\`. This is the gated path
  for a Codex or OpenCode session, which has no \`marketplace_uninstall\` tool.

Either way:

1. Call it with \`name\` (and \`purge: true\` only if the user asked to delete saved
   data). It comes back with \`status: approval_required\`, an \`approvalId\`, and an
   \`approvalToken\`.
2. Tell the user what would be removed and that an approval card is waiting for
   them in DorkOS. Wait for their answer.
3. Call again with the SAME arguments plus the token. Changing any argument,
   \`purge\` included, invalidates the approval.

Read \`reason\` and \`status\` as operating-dorkos describes: \`awaiting_decision\`
means present the same token later, and \`status: "denied"\` means stop.

By default uninstall keeps \`.dork/data/\` and \`.dork/secrets.json\`; \`purge: true\`
removes them, which is a bigger action and worth saying out loud.

\`dorkos uninstall <name>\` also exists. It is the person's verb, and it is gated
for you exactly like the two paths above, so it is not a way around waiting for an
approval. Prefer \`dorkos call marketplace.uninstall\`: it reports the approval
payload in the shape this skill describes.

## Sources: you may read them, only a person may change them

A source is a feed this install fetches and runs code from, so the list of
sources is the person's to set, not yours. What you can do:

- \`dorkos marketplace list\` shows the sources this install reads from.
- \`dorkos marketplace refresh [<name>]\` re-fetches a source's catalog.
- \`dorkos marketplace validate <path-or-url>\` checks a marketplace or package
  file without changing anything.

\`dorkos marketplace add\` and \`dorkos marketplace remove\` exist, but the server
refuses you. You will get a 403 with
\`code: "operator_only_marketplace_source"\`. There is no approval that unlocks
it and retrying will not help, so do not try a second time or look for another
route to the same change.

When you need a package from a feed this install does not read yet, say so and
hand the person the exact line to run:

\`\`\`
dorkos marketplace add <url> --name <name>
\`\`\`

Then wait. They can also do it on the Marketplace sources screen in DorkOS. Once
they have, \`install\` works normally.

## Scaffold your own package (tier: act)

\`marketplace_create_package\` scaffolds a new package under
\`~/.dork/personal-marketplace/packages/<name>/\` and registers it in the personal
marketplace. It uses the \`confirmationToken\` handshake described above. Publishing
to a public marketplace is a separate step that is not part of this flow.

## Rule

Installing, uninstalling, and scaffolding all change the user's system. State
plainly what you are about to do, complete whichever gate the tool asks for
(\`confirmationToken\` for install and scaffold, \`approvalToken\` for uninstall),
then report what landed.`,
};
