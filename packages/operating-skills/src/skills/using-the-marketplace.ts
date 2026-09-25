import type { OperatingSkill } from '../pack.js';
import { TOOL_NAME_NOTE } from '../tool-name-note.js';

/** Teaches an agent to search, inspect, and install marketplace packages. */
export const usingTheMarketplace: OperatingSkill = {
  name: 'using-the-marketplace',
  description:
    'Use when finding, inspecting, installing, updating, or removing a DorkOS marketplace package ' +
    '(agent, plugin, skill pack, or adapter), or reading marketplace sources. Covers search, ' +
    'the install confirmation flow, checking for and applying updates and what they keep, ' +
    'packages held back from sessions until a person approves them, the uninstall approval ' +
    'flow, listing what is installed, and why only a person may add or remove a source.',
  body: `# Using the marketplace

${TOOL_NAME_NOTE}

The marketplace distributes installable packages: agents, plugins, skill packs,
and adapters. Every operation here is a capability, so it is also reachable
with \`dorkos call marketplace.<verb> --input '<json>'\` from any runtime;
\`dorkos capabilities\` lists them with their tiers. On the command line,
\`dorkos marketplace <verb>\` is the home for all of it, and \`dorkos install\`,
\`dorkos update\` and \`dorkos uninstall\` are shorthand for the same three verbs.

## Find a package (tier: observe)

- Search: \`marketplace_search\` with \`query\` and optional \`type\`
  (\`agent\`/\`plugin\`/\`skill-pack\`/\`adapter\`), \`category\`, \`tags\`, or \`marketplace\`.
- Recommend: \`marketplace_recommend\` with a context description
  (e.g. "I need to track errors in my Next.js app") returns ranked matches.
- Details: \`marketplace_get\` with a \`name\` returns its manifest, README, and metadata.

## See what is installed (tier: observe)

- \`marketplace_list_installed\` (filter by \`type\`): one entry per install, tagged
  \`global\` / \`agent-local\` / \`override\`. \`checkUpdates: true\` adds an \`update\`
  block (\`status\`, \`latestVersion\`, \`note\`); it is slower, so ask only when needed.
- \`verify: true\` adds \`integrity\`: \`clean\`, \`modified\` (with the files) or \`unknown\`.
  \`unknown\` needs **Check files** (the app) or \`dorkos marketplace check-files <name>\`.
- \`dorkos marketplace installed [--project <path>] [--json]\` lists the same.
- \`dorkos marketplace outdated [--project <path>] [--json]\` lists only what has an
  update, and answers in its exit code: \`0\` all current, \`1\` something has an
  update, \`2\` could not tell (a package could not be checked, or DorkOS is down).
- \`marketplace_list_marketplaces\` lists the configured sources.

## Install a package (tier: act)

\`marketplace_install\` runs its own confirmation handshake, which is NOT the
approval flow described in operating-dorkos:

1. Call it with the package \`name\`. It returns \`status: requires_confirmation\`
   and a \`confirmationToken\`.
2. Tell the user what will be installed and wait for them to approve in DorkOS.
   Then call it again WITH the \`confirmationToken\` to complete.

Never skip the confirmation step. It is the trust boundary for putting code on
the user's machine. From a shell: \`dorkos marketplace install <name>
[--marketplace <name>] [--source <url>]\`. When it needs a person, it prints a
\`Retry with:\` line carrying \`--approval <token>\`; tell them, wait, then run it.

## Update installed packages (tier: act)

\`marketplace_update\` checks for newer versions and, by default, changes
nothing: one entry per installation with \`status\` (\`update-available\`,
\`current\`, or \`unknown\` with a \`note\`), the versions, and \`installPath\`.
Narrow it with \`names\` or \`installPaths\`.

To install updates, call it with \`apply: true\`. It uses the \`confirmationToken\`
handshake above; the \`updates\` it returns list what each new version runs (its
commands, servers and programs), so tell the user that, wait, then call again with
the SAME arguments plus the token. DorkOS installs exactly what the person saw;
a new version that changed what it runs in the meantime is refused, not installed,
and the result says so. A linked install (a working copy) is never reinstalled.
From a shell: \`dorkos marketplace update\` checks; \`dorkos marketplace update
--apply --yes\` prints what each new version runs and puts a card in front of the
person, then you run the \`Retry with:\` line it printed.

## What an update or reinstall keeps

Files the person and their agents added to a package's folder stay through an
update, a reinstall and an uninstall. If one of the package's own files was
edited, the new version's copy goes in and the edited one is saved beside it as
\`<file>.dork-old\`. A package can mark a file as the person's to edit
(\`userEditable\`, such as a settings file): then the edit stays and the new
default is saved as \`<file>.dork-new\`. Read \`warnings\` on an install's result
(on an update, each entry's \`applied.warnings\`) and tell the person about each. A package may not mark a file that decides what
it runs (hooks, servers, \`bin/\`, skills, commands, extensions) as user-editable,
and one that ships \`.dork/data/\`, \`.dork/secrets.json\` or an install record is
refused.

## Packages that load into every session

A plugin, skill pack or adapter installed for all projects loads into every
session. If it runs programs of its own (hooks, servers, \`bin/\` commands), it
loads only after a person approved that exact install. Their own install or
update counts, and so does a card they granted for yours. Anything else is held
back: a package installed before DorkOS checked this, or a copy that arrived
another way. \`dorkos marketplace held-back\` lists them and why.

You cannot approve one, not even one you installed: \`--allow\` and \`--refuse\`
refuse you. Tell the person which package is held back and why (the note it lists), and
that they can press **Review** on its row under Marketplace, then Installed.

## Remove a package (tier: destructive)

Removing a package is gated on a person's approval and returns the APPROVAL
payload, not a confirmation token. Two gated paths, pick the one your session has:

- **In-session tool:** \`marketplace_uninstall\`, retried with an \`approvalToken\`.
- **Any runtime, from a shell:** \`dorkos call marketplace.uninstall --input
  '{"name":"<pkg>"}'\`, retried with \`--approval <token>\`. This is the path for a
  Codex or OpenCode session, which has no \`marketplace_uninstall\` tool.

1. Call it with \`name\` (and \`purge: true\` only if the user asked to delete what
   they added). It returns \`status: approval_required\` and an \`approvalToken\`.
2. Tell the user what would be removed and that a card is waiting in DorkOS.
3. Call again with the SAME arguments plus the token. Changing any argument,
   \`purge\` included, invalidates the approval.

Read \`reason\` and \`status\` as operating-dorkos describes: \`awaiting_decision\`
means present the same token later, and \`status: "denied"\` means stop.

Uninstall keeps what the person and their agents added (see above) and a later
reinstall picks it up; \`purge: true\` removes it too, so say that out loud.
Uninstalling an agent package also removes that agent from the team: its rooms,
schedules, sign-ins and access go for good, even after a reinstall; say so first.

\`dorkos uninstall <name>\` is the person's verb, and it is gated for you
exactly like the paths above, so it is not a way around an approval.

## Sources: you may read them, only a person may change them

A source is a feed this install fetches and runs code from, so the list is the
person's to set. You can run \`dorkos marketplace list\`, \`refresh [<name>]\`, and
\`validate <path-or-url>\` (checks a marketplace file, changes nothing). A refresh
always checks again; if a source can't be reached it says so, and how old the
copy still shown is. Pass that on rather than calling it refreshed.

\`dorkos marketplace add\` and \`remove\` refuse you with a 403 and
\`code: "operator_only_marketplace_source"\`. No approval unlocks it, so do not
retry or look for another route. Hand the person the line instead, then wait:

\`\`\`
dorkos marketplace add <url> --name <name>
\`\`\`

They can also add it on the Marketplace sources screen. Adding fetches its list
of packages at once, so \`install\` works next; if the source can't be reached
yet, it is still added and the reply names the \`refresh\` that tries again.

## Scaffold your own package (tier: act)

\`marketplace_create_package\` scaffolds a package under
\`~/.dork/personal-marketplace/packages/<name>/\` and registers it in the personal
marketplace, with the same \`confirmationToken\` handshake. Publishing to a public
marketplace is a separate step.

## Rule

Installing, updating, uninstalling, and scaffolding all change the user's system.
State plainly what you are about to do, complete whichever gate the tool asks for
(\`confirmationToken\` for install, update and scaffold, \`approvalToken\` for
uninstall), then report what landed.`,
};
