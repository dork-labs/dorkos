# Portless: Comprehensive Analysis

**Research Date**: 2026-02-21
**Research Depth**: Deep
**Sources**: GitHub repo, marketing site, issues tracker, SKILL.md, release history, third-party coverage

---

## Research Summary

Portless is a Vercel Labs experimental CLI tool (v0.4.0, Apache-2.0) that replaces numbered localhost ports with stable named `.localhost` URLs via a local reverse proxy. Instead of `localhost:3000`, apps run at `myapp.localhost:1355`. It is explicitly designed for both human developers and AI coding agents. The tool is very new (released Feb 2026, ~10 commits), macOS/Linux only, and still resolving foundational issues like HTTPS certificate trust and Docker support.

---

## Key Findings

1. **Core Mechanism**: A single reverse proxy daemon on port 1355 (configurable) routes `<name>.localhost:1355` to apps running on auto-assigned random ports (4000-4999) injected via the `PORT` environment variable. No `/etc/hosts` editing needed — `.localhost` resolves natively to `127.0.0.1` on macOS and Linux.

2. **Monorepo Support**: Each app in a monorepo prefixes its `dev` script with `portless <name>`. Subdomain-style naming (e.g., `api.myapp`, `docs.myapp`) provides hierarchical organization. There is no dedicated config file yet — names are inline in the command.

3. **AI Agent First-Class Citizen**: The tool ships a `skills/portless/SKILL.md` agent skill file and an `AGENTS.md` contribution guide, indicating AI coding agent compatibility is a primary design goal, not an afterthought.

4. **Very Early Stage**: Five releases in four days (v0.1.0 through v0.4.0, all February 2026). Thirteen open GitHub issues covering Windows support, Docker, HTTPS certificate bugs, and missing config file support. No stable release yet.

5. **Escape Hatch**: `PORTLESS=0 pnpm dev` or `PORTLESS=skip` bypasses the proxy entirely, making it safe to integrate into shared `package.json` scripts without breaking teammates who do not want to use it.

---

## Detailed Analysis

### What It Is

Portless is a global npm CLI (`npm install -g portless`) that wraps any dev server command. The syntax is:

```bash
portless <name> <command> [args...]
```

This does three things:
1. Starts the proxy daemon on port 1355 (auto-starts if not running)
2. Finds a free port in the 4000-4999 range and injects it as `PORT`
3. Registers a route: `<name>.localhost:1355` -> that random port

The app is then accessible at `http://<name>.localhost:1355` regardless of what port it actually binds to. The proxy persists across dev server restarts, so the URL never changes even if the underlying port does.

### Technical Architecture

```
Browser
  |
  v
Portless Proxy (port 1355, HTTP/2-capable)
  |        |         |
  v        v         v
app:4012  api:4087  docs:4231
(Next.js) (Express) (Vite)
```

State (route table, PIDs, port files) is stored at:
- `~/.portless/` (user-space, port >= 1024)
- `/tmp/portless/` (root, port < 1024)
- Overridable via `PORTLESS_STATE_DIR`

File-based route watching with fallback polling (added v0.3.0) allows the proxy to pick up new registrations without restart.

### Setup and Configuration

**Installation (global only, not a project dependency):**
```bash
npm install -g portless
```

The tool explicitly blocks `npx portless` and `pnpm dlx portless` (blocked in v0.2.2) to enforce global-only installation, preventing version drift within a project.

**Basic dev script integration:**
```json
{
  "scripts": {
    "dev": "portless myapp next dev"
  }
}
```

**HTTPS/HTTP2:**
```bash
portless proxy start --https
sudo portless trust    # Installs CA into system trust store
```

HTTP/2 multiplexing is significant for Vite-style unbundled dev servers that serve hundreds of small files per page load.

**Custom proxy port:**
```bash
portless proxy start -p 80    # requires sudo
portless proxy start -p 8080
```

**Environment variables:**

| Variable | Effect |
|----------|--------|
| `PORTLESS=0` or `PORTLESS=skip` | Bypass proxy for this invocation |
| `PORTLESS_HTTPS=1` | Enable HTTPS by default |
| `PORTLESS_STATE_DIR=<path>` | Override state storage directory |
| `PORTLESS_PORT` | Override proxy port |

**Custom TLS certificates:**
```bash
portless proxy start --cert ./cert.pem --key ./key.pem
```

### Monorepo Support

Portless has no native "monorepo mode" — the pattern is simply convention-based naming in each workspace's `package.json`:

```json
// apps/client/package.json
{ "scripts": { "dev": "portless myapp next dev" } }

// apps/server/package.json
{ "scripts": { "dev": "portless api.myapp pnpm start" } }

// apps/web/package.json
{ "scripts": { "dev": "portless docs.myapp next dev" } }
```

This gives you stable URLs:
- `http://myapp.localhost:1355` (client)
- `http://api.myapp.localhost:1355` (server)
- `http://docs.myapp.localhost:1355` (web/docs)

**Hierarchical subdomain naming** (`api.myapp`, `docs.myapp`) is the recommended monorepo pattern. There is no enforcement or namespace collision detection — developers must manually coordinate names.

**Issue #8 (open)**: A user has requested a gitignored config file for naming, specifically to support multiple parallel git checkouts (e.g., for running multiple agents against different branches simultaneously) where each checkout needs a distinct name without committing it.

**No Turborepo/pnpm workspace integration**: Portless does not read `pnpm-workspace.yaml`, `turbo.json`, or any monorepo config file. It is framework-agnostic and workspace-agnostic at the tooling level.

### AI Agent Integration

This is a stated primary use case. The marketing site explicitly calls out:

> "AI coding agents guess or hardcode the wrong port, especially in monorepos"

The tool ships `skills/portless/SKILL.md` — a structured prompt file that teaches AI agents how to use Portless. The SKILL.md covers:
- Installation
- Core command syntax
- Multi-app subdomain patterns
- Environment variable overrides
- HTTPS setup flow

The `AGENTS.md` contribution guide requires that any changes affecting CLI behavior must update three files in sync: `README.md`, `skills/portless/SKILL.md`, and `packages/portless/src/cli.ts` (help output). This ensures agent skill documentation stays synchronized with the actual tool.

For DorkOS specifically: agents running in a Portless-configured monorepo would always find services at stable URLs like `api.myapp.localhost:1355` regardless of what port the server actually bound to at startup.

---

## Pros and Cons

### Pros

- **Zero framework configuration**: Works with any framework that respects `PORT` (Next.js, Vite, Express, etc.) — which is essentially all of them
- **One-line integration**: Add `portless <name>` to the front of any dev script
- **Stable URLs survive restarts**: The named URL never changes even if the underlying port changes
- **Cookie and localStorage isolation**: Each `.localhost` subdomain is a separate origin, fixing cookie bleed between apps
- **AI agent friendly**: Explicitly designed to eliminate agent port-guessing; ships a SKILL.md
- **HTTP/2 + auto-trusted TLS**: `portless proxy start --https` handles cert generation and system trust
- **Escape hatch**: `PORTLESS=0` allows per-invocation bypass without modifying scripts
- **Apache-2.0 license**: Permissive, commercially usable
- **No `/etc/hosts` editing**: `.localhost` TLD resolves natively on macOS and Linux

### Cons

- **Windows is not supported** (open issue #15): macOS and Linux only. No timeline given.
- **Global-only installation required**: Cannot be a project dependency. Teams must ensure all developers install it globally, adding onboarding friction.
- **No config file support yet** (open issue #8): App names are hardcoded in `package.json` scripts. No way to override names locally (e.g., per-checkout, per-developer) without modifying version-controlled files.
- **Docker is unsupported** (open issue #30): No guidance or support for containerized development workflows. Proxy runs on the host, but container port binding is a separate concern.
- **HTTPS has known bugs**: Port 443 broken (issue #29), wildcard certificate recognition broken on macOS (issue #28), "md too weak" errors on HTTPS startup (issue #17).
- **Very early stage**: v0.4.0, ~10 commits, all releases within a four-day window in February 2026. API and behavior may change significantly.
- **Vercel Labs provenance**: Experimental arm, not a Vercel product commitment. Could be abandoned.
- **Port range is fixed**: Apps are always assigned ports 4000-4999. Cannot specify a custom port for an app (open issue #11). This may conflict with apps that require a specific port for other reasons.
- **Proxy is a single point of failure**: If the proxy daemon crashes or is not running, all named URLs fail simultaneously. The proxy auto-starts but adds a process dependency.
- **`npx` blocked**: Cannot be run ad-hoc via `npx portless` — only globally-installed invocations work.

---

## Limitations

| Limitation | Status |
|-----------|--------|
| Windows support | Not supported, open issue #15 |
| Docker / Docker Compose | No guidance, open issue #30 |
| App-specific port selection | Not supported, open issue #11 |
| Config file (gitignored per-checkout names) | Not supported, open issue #8 |
| Port 443 HTTPS | Broken, open issue #29 |
| Wildcard certificate on macOS | Broken, open issue #28 |
| `npx`/`pnpm dlx` invocation | Explicitly blocked since v0.2.2 |
| Vite support (explicit) | Open issue #12 (likely works via `PORT`, but unverified edge cases) |
| Parallel checkouts with unique names | Requires workaround (issue #8) |
| Non-Node.js processes that ignore `PORT` | Must use `PORTLESS_PORT` or manual port specification |

---

## Alternatives

### Lightweight Local Proxy Alternatives

**Caddy**
- Production-grade reverse proxy with automatic HTTPS via Let's Encrypt or local CA
- `Caddyfile` syntax is simple: one file maps `api.myapp.localhost` -> `localhost:3000`
- Requires manual configuration per service; not a drop-in CLI wrapper
- Stable, production-proven, Docker-friendly
- Works on Windows, macOS, Linux

**Traefik**
- Service-discovery-based reverse proxy, excellent for Docker Compose / Kubernetes
- Reads labels from `docker-compose.yml` to auto-configure routes
- More complex setup than Portless; overkill for simple local dev without containers
- Handles the Docker case that Portless cannot

**Nginx / nginx-proxy**
- Low-level, highly flexible, requires manual config
- `docker-compose` with `jwilder/nginx-proxy` auto-routes containers by `VIRTUAL_HOST` env var — conceptually similar to Portless but container-oriented

### Certificate Management

**mkcert** (FiloSottile)
- Creates locally-trusted development certificates for any hostname or IP
- Pairs with Caddy or custom `/etc/hosts` entries for named local URLs
- More manual than Portless's `--https` flag but more stable and battle-tested
- Works on Windows, macOS, Linux

### Named Localhost Tunnels (different use case)

**ngrok** / **LocalCan** / **Pinggy**
- These expose local dev servers to the public internet via a tunnel, not just the local network
- Solve a different problem (external access, webhooks) but also provide stable named URLs
- Paid features required for persistent subdomains

### Environment-Level Solutions

**direnv + `.envrc`**
- Assign a fixed port per project via `export PORT=4001` in a gitignored `.envrc`
- Zero tooling overhead, works everywhere including Windows and Docker
- Does not solve the named-URL problem, only the port-collision problem

**Docker Compose with fixed port mappings**
- Define fixed host ports in `docker-compose.yml` per service
- Stable, reproducible, works across platforms
- Requires Docker; adds container overhead for non-containerized apps

### Summary Comparison

| Tool | Named URLs | Auto-certs | Docker | Windows | Config File | Complexity |
|------|-----------|-----------|--------|---------|-------------|-----------|
| **Portless** | Yes (.localhost:1355) | Yes (buggy) | No | No | No | Low |
| **Caddy** | Yes (manual) | Yes (stable) | Yes | Yes | Yes | Medium |
| **Traefik** | Yes (labels) | Yes | Yes | Yes | Yes | High |
| **mkcert + /etc/hosts** | Manual | Yes | Manual | Yes | No | Medium |
| **direnv + PORT** | No | No | No | Partial | Yes (.envrc) | Low |
| **Docker Compose** | No (ports) | No | Yes | Yes | Yes | Medium |

---

## Research Gaps and Limitations

- No public Hacker News, Reddit, or Twitter/X discussion threads found (tool is too new as of Feb 2026)
- The `PORTLESS_PORT` environment variable behavior vs. `--port` CLI flag is not fully documented
- No benchmarks available for proxy overhead at HTTP/1.1 vs. HTTP/2
- Behavior with frameworks that do NOT respect `PORT` (e.g., some Go or Rust servers) is undocumented
- No clarity on whether the proxy survives macOS sleep/wake cycles reliably

---

## Contradictions and Disputes

- The README and SKILL.md describe `.localhost` as resolving natively without `/etc/hosts` changes, but issue #23 raises questions about this. On standard macOS/Linux this is correct (RFC 6761 reserves `.localhost`), but behavior may vary in corporate environments with custom DNS resolvers.
- Marketing site says HTTP/2 is available; v0.4.0 release notes confirm it was just added and issue #9 was still open prior to that release. The implementation uses `allowHTTP1` fallback, meaning not all clients will get HTTP/2.
- Issue #17 ("md too weak" HTTPS error) contradicts the marketing site's framing of HTTPS as a simple one-flag addition.

---

## Search Methodology

- Searches performed: 9
- Tool calls made: 14
- Most productive sources: GitHub repo (README, SKILL.md, issues, releases), port1355.dev marketing site
- Primary domains: github.com/vercel-labs/portless, port1355.dev
- Search terms that produced results: "portless vercel-labs port1355", "alternatives portless localhost caddy traefik", "localhost subdomain dev tools mkcert localcan"

---

## Sources

- [Portless Marketing Site](https://port1355.dev/)
- [GitHub: vercel-labs/portless](https://github.com/vercel-labs/portless)
- [README.md](https://github.com/vercel-labs/portless/blob/main/README.md)
- [AGENTS.md](https://github.com/vercel-labs/portless/blob/main/AGENTS.md)
- [SKILL.md](https://github.com/vercel-labs/portless/blob/main/skills/portless/SKILL.md)
- [Releases](https://github.com/vercel-labs/portless/releases)
- [Issue #8: Config file support](https://github.com/vercel-labs/portless/issues/8)
- [Issue #30: Docker support](https://github.com/vercel-labs/portless/issues/30)
- [Issues tracker](https://github.com/vercel-labs/portless/issues)
- [Portless: Vercel Labs' Fix for the localhost Port Number Problem](https://darkwebinformer.com/portless-vercel-labs-fix-for-the-localhost-port-number-problem/)
- [mkcert: GitHub](https://github.com/FiloSottile/mkcert)
