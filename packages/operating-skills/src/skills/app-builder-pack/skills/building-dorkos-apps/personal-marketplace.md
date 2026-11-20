# Building in the personal marketplace

Use this when your own `.dork/extensions/` folder is read-only: a marked turn, or one
held to a limit. A room with another person in it marks your turn, and so do Telegram
and Slack. Your file tools can't write that folder then, and `create_extension`
creates nothing. That rule is on purpose: code in that folder runs without a click,
so words from someone other than the person you work for must not reach it.

The personal marketplace is the route that works. Each version becomes one card the
person approves in DorkOS.

1. `marketplace_create_package(name, type: "plugin", description)` once. It asks the
   person first. Its reply gives the package's `packagePath`.
2. Write the app into `<packagePath>/.dork/extensions/<app id>/`: the same
   `extension.json`, `index.ts` and, only if needed, `server.ts` as in SKILL.md.
3. `marketplace_install(name, marketplace: "personal")` the first time. It asks the
   person first.
4. For each new version: change the files, raise `version` in the package's
   `.dork/manifest.json` and in the app's `extension.json`, then
   `marketplace_update(names: [name], apply: true)`. Without `apply` it only checks,
   and in a marked turn even the check asks for a card.
5. An app with server code also waits for the person to allow it in Activity, after
   the first install and after each version that changes its files. Say so.

Everything else in SKILL.md still applies: least privilege, `test_extension`, checking
`serverStatus`, the screenshots and the reach list.

Never ask the person to copy files in from Terminal, and never write into
`~/.dork/plugins/` or any other installed copy yourself.
