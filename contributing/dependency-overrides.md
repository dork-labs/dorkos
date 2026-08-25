# Dependency Overrides

`pnpm.overrides` in the root `package.json` rewrites the version of a package **anywhere** in the tree, including the specs our own workspace packages declare. That reach is the point, and it is also the hazard: an override that outlives its reason silently pins a dependency, and the next person to bump that dependency will change a spec and watch nothing happen.

`package.json` is strict JSON, so the map cannot carry comments. This page is where each entry's reason lives.

## The two kinds

Every override belongs to exactly one of these, and the map is ordered so the two groups stay visually separate.

**Deliberate pins** — the version is a decision. These stay until the decision changes.

| Override                               | Why                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@anthropic-ai/claude-agent-sdk`       | Runtime SDK. Upgrades go through `contributing/adding-a-runtime.md` and the `upgrading-runtime-dependencies` skill, never a routine bump                                                                                                                                                                                             |
| `@anthropic-ai/sdk`                    | Held in lockstep with the agent SDK above, which peers on it                                                                                                                                                                                                                                                                         |
| `@modelcontextprotocol/sdk`            | One MCP wire version across server, CLI and the agent SDK; two copies mean two protocol implementations                                                                                                                                                                                                                              |
| `@types/node`                          | The Node line we target (24.x). Never 26.x                                                                                                                                                                                                                                                                                           |
| `lucide-react`, `@vitejs/plugin-react` | Deduped on purpose — two copies of either is a bundle-size and behaviour hazard                                                                                                                                                                                                                                                      |
| `drizzle-orm`                          | Must match the version `@dorkos/db` generates migrations with                                                                                                                                                                                                                                                                        |
| `eslint-plugin-react-hooks`            | Deduped against the copy `eslint-config-next` pulls transitively — without the override pnpm keeps that copy on whatever it last resolved instead of re-resolving to the range `@dorkos/eslint-config` declares, so two lint-time copies drift apart silently. 7.1.x flagged seven real violations in `apps/site`, fixed in DOR-1541 |
| `vite@7`                               | Scoped to the vite-7 consumers only; the apps stay on vite 6                                                                                                                                                                                                                                                                         |
| `@esbuild-kit/core-utils>esbuild`      | Scoped to the one stale consumer that asks for the vulnerable `~0.18.20`. Deliberately **not** a blanket `esbuild` pin — vite 6 needs `^0.25.0` and tsx needs `~0.28.0`, so a single forced version breaks one of them                                                                                                               |
| `jose`                                 | Deduped to keep `@better-auth/core` a single instance. See below (DOR-1538)                                                                                                                                                                                                                                                          |

### `jose` — why a dedupe pin, and when it goes

`@a2a-js/sdk@1.0` requires `jose@^6.2.3`, against a lockfile that held `6.2.2` for `better-auth`. Both specs are satisfiable, so pnpm did the reasonable thing and kept two copies — but `jose` is a **peer** of `@better-auth/core`, so a second `jose` forked `@better-auth/core@1.6.23` into two peer-resolved instances too.

Two instances of that package are two different `HookEndpointContext` types, and the server typecheck fails with a wall of `better-auth` errors that name neither `jose` nor A2A. The pin collapses both back to one instance by putting every consumer on `^6.2.10`, which is inside `better-auth`'s own range — nothing is being held back.

**Drop it when `better-auth` moves past 1.6.23** and the tree re-resolves to a single `@better-auth/core` on its own. That day is gated on the exact `better-auth` pin below coming off, so read that section first — `better-auth` is held at 1.6.23 on purpose. To check, remove the entry, reinstall, and run `grep -oE "^  jose@[0-9.]+" pnpm-lock.yaml | sort -u` — a single version means the pin is no longer doing anything. (Each version appears on two lines, once per lockfile section, so count versions and not lines.) `pnpm --filter @dorkos/server typecheck` is the real arbiter: that is what broke (DOR-1538).

This is the shape to recognize, because the error never points at the cause: **a new dependency bumps a transitive package that is somebody else's peer, and an unrelated package's types break.** If a routine upgrade produces type errors in a package you did not touch, look for a duplicated peer in the lockfile before you look at the types.

**Transient security pins** — the only reason is an unpatched advisory reachable through a transitive dependency we do not control. **Drop each one as soon as the dependency that pulls it in ships a version that resolves past it**; `pnpm audit` is the check.

`lodash-es`, `dompurify`, `hono`, `@hono/node-server`, `axios`, `fast-uri`, `undici`, `form-data`, `tar`, `tmp`, `@xmldom/xmldom`, `brace-expansion@1|2|5`, `js-yaml@3|4`, `nanoid@5`, `uuid@11`, `linkify-it`, `ip-address`, `qs`, `body-parser`, `@babel/core`.

Two shapes worth copying when you add to this group:

- **Per-major scoping.** `js-yaml@3` and `js-yaml@4` are separate entries because `gray-matter` needs the 3.x line and a blanket `^4` would break it. Same for `brace-expansion` and `uuid@11` (the direct `uuid` 13 dependency must not move).
- **Transitive-only.** `uuid@11` pins a transitive copy; the workspace's own `uuid` stays on 13.

## Version holds that are not overrides

Not every deliberate hold belongs in the override map. When the repo declares the package directly in every place it is used, an **exact spec in each declaring `package.json`** does the same job and is visible where a person actually looks — the file they are editing when they bump it.

### `better-auth` — pinned exact at 1.6.23 (DOR-1538)

`better-auth` and `@better-auth/api-key` are declared exact — `"1.6.23"`, not `"^1.6.23"` — in `apps/server`, `apps/site` and `packages/cli`. Do not loosen either one.

**Why.** `better-auth@1.7.1` breaks two things at once:

- **The server typecheck**, through the duplicate-instance mechanism described above — two copies of `@better-auth/core` are two incompatible sets of types.
- **CLI auth at runtime**, which no typecheck catches: `dorkos auth enable` exits 1, and signing in with a freshly created credential comes back `INVALID_EMAIL_OR_PASSWORD`.

**1.6.30 is not a safe middle ground either.** From 1.6.24 the tree pulls `better-call@1.4.0`, which needs `@better-auth/utils@0.5.0` while `better-auth` itself still needs `0.4.2` — two copies of `@better-auth/utils`, same shape of failure.

**Why an exact spec and not an override.** Both were measured against a deleted lockfile and both hold, so the tie-breaker is maintenance: an override duplicating a spec the repo already declares is the redundancy rule 2 below warns about, and it would give the next bump a fourth place to remember. Add an override only if `better-auth` ever arrives transitively, through a dependency we do not declare.

**How the exact spec reaches the rest of the family.** `better-auth@1.6.23` pins its own dependencies exactly — `@better-auth/core@1.6.23`, `@better-auth/utils@0.4.2`, `better-call@1.3.7` — so holding the one package holds all of them. `@better-auth/api-key` needs its own exact spec because it is a separate declaration whose peers would otherwise resolve against a newer core.

**Drop it when** a `better-auth` release resolves, from a deleted lockfile, to a single `@better-auth/core` and a single `@better-auth/utils`, _and_ CLI auth still works end to end. Both halves are required — wave 1 of the 2026-08-24 dependency sweep passed neither, and the runtime half is the one no gate would have caught.

To re-test after changing the spec:

```bash
rm pnpm-lock.yaml && pnpm install            # fresh resolution, nothing held by the lockfile
find node_modules/.pnpm -maxdepth 1 \
  \( -name '@better-auth+core@*' -o -name '@better-auth+utils@*' \) \
  | sed 's|.*/||' | sort -u                  # must print exactly one of each
git show HEAD:pnpm-lock.yaml > pnpm-lock.yaml && pnpm install   # restore (git checkout is blocked)
pnpm exec prettier --write pnpm-lock.yaml
```

Then the runtime half, which the typecheck does not cover:

```bash
pnpm vitest run apps/server/src/services/core/auth/__tests__/auth.integration.test.ts
DORK_HOME=$(mktemp -d) node packages/cli/dist/bin/cli.js auth enable --email you@example.test --password correct-horse-battery-staple
```

`auth enable` must exit 0 and the integration test's sign-up → sign-in → `get-session` chain must pass; that chain is what 1.7.1 broke.

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
