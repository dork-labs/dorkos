# Dependency Overrides

`pnpm.overrides` in the root `package.json` rewrites the version of a package **anywhere** in the tree, including the specs our own workspace packages declare. That reach is the point, and it is also the hazard: an override that outlives its reason silently pins a dependency, and the next person to bump that dependency will change a spec and watch nothing happen.

`package.json` is strict JSON, so the map cannot carry comments. This page is where each entry's reason lives.

## The two kinds

Every override belongs to exactly one of these, and the map is ordered so the two groups stay visually separate.

**Deliberate pins** — the version is a decision. These stay until the decision changes.

| Override                               | Why                                                                                                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@anthropic-ai/claude-agent-sdk`       | Runtime SDK. Upgrades go through `contributing/adding-a-runtime.md` and the `upgrading-runtime-dependencies` skill, never a routine bump                                                                               |
| `@anthropic-ai/sdk`                    | Held in lockstep with the agent SDK above, which peers on it                                                                                                                                                           |
| `@modelcontextprotocol/sdk`            | One MCP wire version across server, CLI and the agent SDK; two copies mean two protocol implementations                                                                                                                |
| `@types/node`                          | The Node line we target (24.x). Never 26.x                                                                                                                                                                             |
| `lucide-react`, `@vitejs/plugin-react` | Deduped on purpose — two copies of either is a bundle-size and behaviour hazard                                                                                                                                        |
| `drizzle-orm`                          | Must match the version `@dorkos/db` generates migrations with                                                                                                                                                          |
| `eslint-plugin-react-hooks`            | 7.1.x flags seven pre-existing violations in `apps/site`. Held until those are fixed (DOR-1526)                                                                                                                        |
| `vite@7`                               | Scoped to the vite-7 consumers only; the apps stay on vite 6                                                                                                                                                           |
| `@esbuild-kit/core-utils>esbuild`      | Scoped to the one stale consumer that asks for the vulnerable `~0.18.20`. Deliberately **not** a blanket `esbuild` pin — vite 6 needs `^0.25.0` and tsx needs `~0.28.0`, so a single forced version breaks one of them |

**Transient security pins** — the only reason is an unpatched advisory reachable through a transitive dependency we do not control. **Drop each one as soon as the dependency that pulls it in ships a version that resolves past it**; `pnpm audit` is the check.

`lodash-es`, `dompurify`, `hono`, `@hono/node-server`, `axios`, `fast-uri`, `undici`, `form-data`, `tar`, `tmp`, `@xmldom/xmldom`, `brace-expansion@1|2|5`, `js-yaml@3|4`, `nanoid@5`, `uuid@11`, `linkify-it`, `ip-address`, `qs`, `body-parser`, `@babel/core`.

Two shapes worth copying when you add to this group:

- **Per-major scoping.** `js-yaml@3` and `js-yaml@4` are separate entries because `gray-matter` needs the 3.x line and a blanket `^4` would break it. Same for `brace-expansion` and `uuid@11` (the direct `uuid` 13 dependency must not move).
- **Transitive-only.** `uuid@11` pins a transitive copy; the workspace's own `uuid` stays on 13.

## Before you add one

1. **Bump the direct dependency first.** An override is what you reach for when no reachable direct bump clears the finding.
2. **Check nothing already covers it.** A redundant override is worse than none — `electron-builder` already pins `app-builder-lib` and `builder-util-runtime` as exact direct dependencies, so pinning those again only fights the next bump (DOR-1526).
3. **Keep the override at or above every declared spec.** A stale override masks the specs it rewrites: `ws: ^8.21.0` held the tree at 8.21.0 while `apps/server` and `packages/cli` declared `^8.21.3` (DOR-1526). Nothing warns about this — the declared range simply stops meaning anything.

## What overrides cannot do

**Overrides do not reach auto-installed peer dependencies,** and pnpm resolves those to _latest_ rather than to the peer range. When a package's peer is not declared by any importer, pnpm installs it on its own and no override redirects it.

The fix is to declare the peer explicitly in the importer that needs it. Two in this repo exist for exactly that reason:

- `packages/icons` declares `react` as a devDependency. Its React peer stranded on 19.2.7 while the apps moved to 19.2.8, loading two React copies.
- `apps/desktop` declares `electron-builder-squirrel-windows`. `app-builder-lib` declares it as an exact, non-optional peer, and the auto-installed copy drifted out of lockstep with the rest of the electron-builder family.

## Related

- `contributing/desktop-app-development.md` — the electron-builder family
- `contributing/adding-a-runtime.md` — runtime SDK upgrades
