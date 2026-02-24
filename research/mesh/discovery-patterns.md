# DorkOS Mesh: Service Discovery & Agent Discovery Patterns

**Research Date:** 2026-02-24
**Research Mode:** Deep Research
**Searches Performed:** 14 web searches + 3 page fetches
**Topic:** Service discovery and agent discovery patterns for a filesystem-based, local-first AI agent network

---

## Research Summary

Service discovery is a solved problem in distributed systems, with three dominant patterns: centralized registries (Consul, etcd), DNS-based broadcast (mDNS/DNS-SD), and filesystem convention scanning (systemd, npm, VS Code). For DorkOS Mesh — where each project directory is an autonomous AI agent on a single developer machine — the right architecture combines filesystem-convention scanning for initial discovery, a lightweight in-process registry daemon for runtime state, and file-watching for live updates. The emerging A2A (Agent2Agent) protocol from Google formalizes agent cards as the standard manifest format and is the closest prior art for what Mesh needs to build.

---

## Key Findings

1. **The Registry Pattern Dominates Production Systems** — Consul, etcd, and ZooKeeper all converge on a central registry with TTL-based health tracking. Agents register themselves; the registry handles expiry. This model works but requires a running registry process. For DorkOS Mesh, a lightweight SQLite-backed registry living in `~/.dork/mesh.db` provides the benefits without the operational overhead.

2. **Filesystem Convention Is the Proven Local Pattern** — systemd, npm, VS Code, Obsidian, and Next.js all use filesystem scanning with well-known filenames or directory structures. None require a running "registry daemon" for discovery — the filesystem itself is the registry. DorkOS Mesh should follow this pattern: every project directory with a `.claude/` folder is a potential agent.

3. **Manifests Declare Capabilities; Watchers Maintain Liveness** — VS Code's `package.json#contributes`, MCP's capability negotiation, Claude Code's `.claude/agents/*.md` frontmatter, and A2A's `agent-card.json` all use declarative manifests to enumerate what an agent can do. The manifest is read once at discovery time; file watchers handle changes. This separation of concerns is important.

4. **A2A Agent Cards Are the Closest Industry Prior Art** — Google's Agent2Agent protocol, released April 2025, defines a `/.well-known/agent-card.json` pattern where each agent publishes a structured JSON "business card" listing its skills, endpoint, and auth requirements. For DorkOS Mesh, an analog at `.claude/agent.json` (or derived from CLAUDE.md frontmatter) is the natural manifest format.

5. **Event-Based File Watching Beats Polling for Local Filesystems** — chokidar with native backends (FSEvents on macOS, inotify on Linux) provides sub-100ms change notification with near-zero CPU overhead for local files. Polling is only appropriate for network-mounted filesystems. Since DorkOS Mesh is local-first, event-based watching is correct.

6. **Claude Code's Own Subagent System Offers Direct Precedent** — `.claude/agents/*.md` files with YAML frontmatter are discovered by scanning a directory — no daemon, no registration step. Capabilities, tool restrictions, model selection, and permission modes are all declared in frontmatter. DorkOS Mesh can mirror this exact pattern at the project level.

---

## Detailed Analysis

### 1. Service Discovery Patterns in Established Systems

#### 1.1 The Registry Approach (Consul, etcd, ZooKeeper)

All three tools centralize service state in a distributed key-value store with health monitoring. Their patterns diverge in important ways:

**Consul** is the most opinionated: services register via HTTP API or a config file in `/etc/consul.d/`, providing name, address, port, and health check configuration. Consul runs periodic health checks (HTTP, TCP, or script-based) and automatically removes failing instances. Clients query Consul's DNS interface or HTTP API. Registration can be self-reported (the service registers itself on startup) or third-party (an external process registers on behalf of a service that cannot talk to Consul directly). Consul also supports tags for capability metadata.

**etcd** is a pure key-value store. Service registration is implemented by convention: services write their address/metadata to a well-known key path and maintain a TTL lease. If the service fails to renew the lease (via heartbeat), etcd expires the key automatically. Discovery is a key-range scan. etcd does not define "services" as a first-class concept — that is the application's responsibility.

**ZooKeeper** uses ephemeral nodes in a hierarchical namespace (like a filesystem). When a service starts, it creates an ephemeral znode at a well-known path. If the service dies (its session expires), ZooKeeper automatically deletes the node. Clients watch the parent path and receive change notifications. This is the closest analogue to "filesystem as registry" — the ZooKeeper namespace is literally a virtual filesystem.

**Key insight for Mesh:** The ZooKeeper ephemeral node pattern maps cleanly to the local filesystem. Each project's presence (or absence) of `.claude/agent.json` is the "node." File watchers replace ZooKeeper's watch primitive. The session expiry mechanism is not needed for a local filesystem since files persist until explicitly deleted — liveness is handled differently (a running process indicator, a PID file, or a heartbeat socket).

**Registration Modes:**
- **Self-registration**: The agent process registers itself on startup (Consul, Eureka). Requires the agent to know about the registry.
- **Third-party registration**: An external process (a DorkOS Mesh daemon) watches the filesystem and registers agents on their behalf. The agent only needs to have the right files in place.

For Mesh, third-party registration via filesystem scanning is preferable because it requires zero changes to existing Claude Code projects.

#### 1.2 DNS-Based Discovery (mDNS / DNS-SD / Bonjour)

DNS-SD (RFC 6763) and mDNS work as follows: a service announces itself via a PTR record of the form `_servicetype._tcp.local` pointing to an SRV record with the hostname and port, plus TXT records for metadata. Clients send multicast UDP queries to `224.0.0.251:5353` (IPv4) or `[FF02::FB]:5353` (IPv6). Any service matching the query type responds with its own SRV/TXT records. No central registry is required.

This is the zero-configuration networking approach — Apple's Bonjour (avahi on Linux) implements it for printers, AirPlay, etc.

**Relevance to Mesh:** mDNS/DNS-SD is designed for network service discovery across machines on a local subnet. For a single-machine system like DorkOS Mesh (initial scope), it is overkill and adds unnecessary complexity. However, mDNS becomes interesting for **future federation** — if DorkOS Mesh ever needs to discover agents across multiple developer machines on the same network, registering agents as mDNS services (`_dorkos-agent._tcp.local`) would enable zero-config cross-machine discovery without any infrastructure.

The A2A protocol uses a `.well-known/agent-card.json` pattern that is essentially the filesystem analog of mDNS service announcement — each agent declares itself in a well-known location rather than broadcasting.

#### 1.3 Kubernetes Service Discovery

Kubernetes combines three mechanisms:
1. **DNS-based**: Each Service gets a DNS entry `<service>.<namespace>.svc.cluster.local`. Pods discover services by querying DNS. CoreDNS watches the Kubernetes API for Service objects and creates/removes DNS entries.
2. **Environment variables**: Kubernetes injects `<SERVICE_NAME>_SERVICE_HOST` and `<SERVICE_NAME>_SERVICE_PORT` into every Pod's environment at creation time.
3. **kube-proxy / iptables**: Traffic to service IPs is intercepted by kube-proxy and forwarded to healthy backend pods.

The Kubernetes pattern demonstrates server-side discovery: a central control plane (the API server) knows all services; clients only need DNS. The cluster is effectively a giant service registry with an HTTP API and watch subscriptions for change notifications.

**Relevance to Mesh:** The Kubernetes API server's watch mechanism (`GET /api/v1/services?watch=true` returning a stream of change events) is a useful pattern for Mesh's agent stream API. A client can subscribe to agent lifecycle events without polling.

#### 1.4 Client-Side vs. Server-Side Discovery

**Client-side discovery**: The client queries a registry, gets a list of service instances, applies its own load-balancing logic, and connects directly. Used by: Netflix Eureka + Ribbon, Consul with client agents.
- Pro: No additional network hop, no LB bottleneck
- Con: Client must implement discovery logic; tight coupling to registry client library

**Server-side discovery**: A load balancer or API gateway sits in front of services. Clients connect to the LB, which queries the registry and routes. Used by: Kubernetes Services, AWS ELB + Route 53.
- Pro: Clients are simple; discovery logic is centralized
- Con: LB is a single point of failure; extra network hop

**For DorkOS Mesh:** Client-side discovery is appropriate since this is a local system with a single process. Agents query the Mesh registry (the `~/.dork/mesh.db` SQLite file or an in-process registry object) and communicate directly with their peers. There is no load balancer needed.

---

### 2. Filesystem-Based Discovery Precedents

#### 2.1 systemd Unit File Scanning

systemd discovers services by scanning well-known directories in priority order:
1. `/etc/systemd/system/` — administrator-defined units (highest priority)
2. `/run/systemd/system/` — runtime units
3. `/lib/systemd/system/` — vendor/package units (lowest priority)

Unit files are INI-format files with a `.service`, `.socket`, `.timer`, or other extension. systemd runs `systemctl daemon-reload` to re-scan — it does not watch directories live; it scans on demand.

**Key patterns from systemd:**
- **Priority layering**: Higher-priority directories override lower-priority ones. A file in `/etc/` with the same name as one in `/lib/` takes precedence.
- **Aliases via symlinks**: A symlink in a unit directory is an alias. `systemctl enable foo.service` creates a symlink from a `wants/` or `requires/` directory.
- **Drop-in directories**: `foo.service.d/override.conf` fragments extend a unit without replacing it. This is a powerful extension mechanism.
- **Template units**: `foo@.service` is a template; `foo@bar.service` is an instance with argument `bar`.

**Application to Mesh:** The priority layering and drop-in pattern are directly applicable. A project-level `.claude/agent.json` could override or extend a user-level `~/.claude/agent.json` default. Drop-in style config merging (deep merge of YAML/JSON fragments) lets per-project config extend a shared base.

#### 2.2 npm / Node.js Package Discovery

npm discovers packages via `node_modules/` directory scanning. Node's module resolution algorithm walks up the directory tree looking for `node_modules/` directories, then reads `package.json` to find the package's entry point. The `exports` field in `package.json` provides a structured capability map: conditional exports declare what a package exposes under what conditions (ESM vs. CJS, browser vs. Node.js, development vs. production).

**Key patterns from npm:**
- **Convention-driven**: Every package has `package.json` at its root. No registration step; presence of the file is the declaration.
- **Hierarchical resolution**: Node walks up the directory tree. This is a form of lexicographic priority — closer `node_modules/` directories win.
- **Capability declaration via `exports`**: The `exports` field is a structured capability map. A package declares what it can provide under different conditions.

**Application to Mesh:** The "walk up the tree" resolution is relevant for agent lookup — a Mesh agent should be discoverable from any subdirectory of its project. The `exports` pattern maps to a Mesh agent declaring which "skills" or "tools" it exposes.

#### 2.3 Next.js File-Based Routing

Next.js treats the filesystem as a declaration of HTTP routes. `app/dashboard/page.tsx` → `/dashboard`. Special filenames (`layout.tsx`, `loading.tsx`, `error.tsx`) have reserved meanings. Parenthesized directories `(group)` create route groups without affecting the URL.

**Key patterns from Next.js:**
- **Filesystem as truth**: Zero configuration required; the file's existence is its registration.
- **Reserved filenames**: Well-known names (`page.tsx`, `layout.tsx`) have defined roles. All other files are inert.
- **Colocation**: Route-specific components (loading states, error boundaries) live alongside the route file. No central config file.

**Application to Mesh:** The "reserved filename" pattern maps perfectly. `.claude/agent.json` (or deriving capabilities from `CLAUDE.md` frontmatter) is the `page.tsx` equivalent — its presence declares the directory as a Mesh agent. Other `.claude/` contents (commands, settings, rules) are colocated capability declarations.

#### 2.4 VS Code Extension Discovery

VS Code discovers extensions by scanning `~/.vscode/extensions/` for directories containing `package.json` with a specific schema. The `contributes` field in `package.json` is a structured capability declaration: it lists commands, keybindings, language grammars, themes, debug adapters, etc. Extensions are loaded at startup or lazily via `activationEvents`.

```json
{
  "name": "my-extension",
  "publisher": "acme",
  "contributes": {
    "commands": [
      { "command": "acme.doThing", "title": "Do the Thing" }
    ],
    "languages": [
      { "id": "myLang", "extensions": [".mylang"] }
    ]
  },
  "activationEvents": ["onLanguage:myLang"]
}
```

**Key patterns from VS Code:**
- **Structured capability declaration**: `contributes` is a typed, schema-validated map of capabilities.
- **Lazy activation**: Extensions declare when they should activate (`activationEvents`). This prevents loading every extension for every task.
- **Publisher namespace**: `publisher.name` provides a namespaced identifier, preventing collisions.
- **Scanning a known directory**: VS Code scans one well-known directory. No env vars, no PATH manipulation.

**Application to Mesh:** The `contributes` pattern maps to Mesh's agent capability declaration. An agent's manifest declares what tasks it handles. Lazy activation (`activationEvents`) maps to intent-based routing in Mesh — agents declare what kinds of requests they handle, and the Mesh router only activates the right agent for a given task.

#### 2.5 Obsidian Plugin Discovery

Obsidian discovers plugins by scanning `.obsidian/plugins/<plugin-id>/` directories within the vault. Each plugin directory must contain `manifest.json` with typed metadata. The `id` field in `manifest.json` must match the directory name. Obsidian reads `manifest.json` to check version compatibility before loading `main.js`. Any changes to `manifest.json` require an Obsidian restart.

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "minAppVersion": "0.15.0",
  "description": "What this plugin does",
  "author": "Author Name",
  "authorUrl": "https://example.com",
  "isDesktopOnly": false
}
```

**Key patterns from Obsidian:**
- **Directory name = ID**: The directory name is the canonical identifier. The manifest's `id` must match it.
- **Version gating**: `minAppVersion` prevents loading incompatible plugins. Mesh agents could declare a `minMeshVersion` for protocol compatibility.
- **Restart-required changes**: Obsidian's simplicity comes at a cost — no hot-reload of manifests. Mesh should support hot-reload via file watchers.

---

### 3. Agent Manifest Formats

#### 3.1 package.json as a Universal Manifest Pattern

`package.json` demonstrates the power of a well-specified, JSON-schema-validated manifest. Its anatomy:
- **Identity**: `name`, `version`, `description`, `author`
- **Entry points**: `main`, `exports`, `bin`
- **Capabilities**: `scripts`, `peerDependencies`, `engines`
- **Extensibility**: Third-party tools add their own top-level keys (`eslint`, `jest`, `prettier`)

The extensibility pattern — well-known top-level keys for recognized tools, arbitrary keys for others — is critical. It allows the manifest format to grow without versioning the core schema.

#### 3.2 MCP Tool Manifests

MCP (Model Context Protocol) defines a capability negotiation handshake:
1. Client sends `initialize` with `clientInfo` and `capabilities`
2. Server responds with `serverInfo` and `capabilities` (listing supported features: tools, resources, prompts, sampling, roots)
3. Client sends `initialized` notification
4. Client calls `tools/list` to get the full tool manifest

Each tool in the manifest has:
```json
{
  "name": "read_file",
  "description": "Read the contents of a file",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "File path to read" }
    },
    "required": ["path"]
  }
}
```

MCP uses JSON-RPC 2.0 over stdio (for local tools) or HTTP+SSE (for remote tools). The capability negotiation pattern ensures backward compatibility — clients only use features both sides advertise.

**Key insight:** MCP's two-phase design (static manifest declaration + dynamic capability negotiation at connection time) is powerful. The static manifest (file on disk) answers "can this agent handle this type of task?" The dynamic negotiation answers "which specific version of the protocol do we share?"

#### 3.3 Claude Code Subagent Manifests (.claude/agents/*.md)

Claude Code's own agent system uses YAML frontmatter in Markdown files:

```yaml
---
name: code-reviewer
description: Expert code review specialist. Use immediately after writing or modifying code.
tools: Read, Grep, Glob, Bash
model: sonnet
permissionMode: default
maxTurns: 50
memory: user
---

System prompt content here...
```

**Discovery mechanism:** Claude Code scans `.claude/agents/` at session start. User-level agents live in `~/.claude/agents/`. CLI-defined agents are passed as JSON. Priority order: CLI > project > user > plugin.

**Key patterns:**
- **Description-as-routing**: The `description` field is what Claude uses to decide when to delegate. This is semantic routing — the description is a natural language capability declaration.
- **Priority layering**: The same agent name at a higher-priority location overrides lower-priority definitions. Identical to systemd's `/etc/` vs. `/lib/` priority.
- **Tool allowlist/denylist**: `tools` (allowlist) and `disallowedTools` (denylist) are explicit capability constraints.
- **Isolation modes**: `permissionMode` controls what the subagent is allowed to do. `isolation: worktree` runs the agent in a git worktree.

This is the most directly relevant prior art for DorkOS Mesh agent manifests. Mesh agents should extend this format rather than invent a new one.

#### 3.4 A2A Agent Cards

Google's Agent2Agent protocol (released April 2025) defines the `Agent Card` as a JSON document at `/.well-known/agent-card.json`:

```json
{
  "name": "DataAnalystAgent",
  "description": "Analyzes datasets and generates insights",
  "url": "https://agent.example.com/a2a",
  "version": "1.0.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": false
  },
  "skills": [
    {
      "id": "data-analysis",
      "name": "Data Analysis",
      "description": "Analyze CSV, JSON, or SQL data sources",
      "tags": ["data", "analytics", "sql"]
    }
  ],
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "authentication": {
    "schemes": ["Bearer"]
  }
}
```

A2A defines three discovery strategies:
1. **Well-known URI**: Agents publish at `/.well-known/agent-card.json`
2. **Curated registries**: A central service indexes agent cards; clients query by capability/tag
3. **Direct configuration**: Hardcoded URL or env var (for tightly coupled systems)

**Key insight for Mesh:** The A2A `skills` array with `tags` is exactly the routing mechanism Mesh needs. A Mesh orchestrator looking for an agent to "review Python code" can match against skill descriptions and tags without invoking the agent. The `capabilities` object declares protocol features (streaming, push notifications) — Mesh should have an analogous section for agent protocol features.

#### 3.5 Docker Labels as Capability Annotations

Docker Compose uses YAML `labels` for unstructured metadata:

```yaml
services:
  web:
    image: nginx
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.web.rule=Host(`example.com`)"
      - "com.example.team=backend"
      - "com.example.environment=production"
```

Labels are key-value pairs. Tools like Traefik, Prometheus, and Watchtower watch Docker containers and read specific label namespaces to configure themselves. This is a powerful extensibility mechanism: the core label system is untyped, but each tool defines a typed sub-namespace.

**Application to Mesh:** A Mesh agent manifest's metadata section could use a similar namespaced key-value approach for extensibility — `mesh.routing.tags`, `mesh.auth.mode`, `pulse.schedule.cron` — letting subsystems annotate agents without requiring changes to the core manifest schema.

---

### 4. File Watchers vs. Polling vs. Manual Registration

#### 4.1 Event-Based File Watching

**Mechanism:** OS kernel notifies userspace of filesystem events without polling.
- **macOS:** FSEvents API — reports changes at the directory level, with some coalescing. Highly efficient; used by Spotlight, Time Machine.
- **Linux:** inotify — reports individual file events (create, modify, delete, move). Per-inode watches.
- **Windows:** ReadDirectoryChangesW — reports changes within a directory tree.

**chokidar** is the Node.js abstraction layer that normalizes these APIs. It defaults to native watchers and falls back to polling when native APIs are unavailable (e.g., network filesystems, Docker volumes on macOS).

```javascript
import chokidar from 'chokidar';

const watcher = chokidar.watch('~/.dork/mesh/', {
  persistent: true,
  ignoreInitial: false,  // emit 'add' for existing files
  depth: 2,              // watch subdirectories up to 2 levels deep
  usePolling: false,     // use native events
});

watcher
  .on('add', path => discoverAgent(path))
  .on('change', path => refreshAgent(path))
  .on('unlink', path => removeAgent(path));
```

**Performance:** Near-zero CPU when idle. Sub-100ms latency on local filesystems. Scales to hundreds of watched paths.

**Limitations:**
- Watching deeply nested directories can exhaust OS inotify watch limits on Linux (default 8192). Configurable via `/proc/sys/fs/inotify/max_user_watches`.
- On macOS, FSEvents coalesces rapid changes — multiple writes to the same file within a short window may produce a single event.
- Does not work reliably for network-mounted filesystems (NFS, SMB, Docker volumes on macOS).

**Recommendation for Mesh:** Use chokidar to watch the set of discovered agent directories for manifest changes. Watch `~/.dork/mesh/` (the Mesh registry directory) and a configurable list of project directories. Use `ignoreInitial: false` to process existing agents on startup.

#### 4.2 Polling

**Mechanism:** A timer fires periodically and compares current filesystem state against cached state.

**When polling is appropriate:**
- Network filesystems where kernel events are not delivered to the local machine
- Docker volumes on macOS (where filesystem events from inside the container don't propagate)
- Extremely high-change-rate directories where event storms are a problem
- Consistency guarantees require a known poll interval (e.g., "check every 30 seconds exactly")

**Performance:** CPU proportional to poll frequency and number of watched files. A 1-second poll of 100 files with `stat()` calls is measurable but typically acceptable. A 100ms poll of 10,000 files is not.

**Recommendation for Mesh:** Use polling only as a fallback when native watchers fail. Implement a configurable poll interval (default: 30 seconds) for network-mounted project directories. chokidar supports `usePolling: true` with `interval` and `binaryInterval` settings.

#### 4.3 Manual Registration

**Mechanism:** Agents explicitly register themselves with the Mesh registry via API or CLI.

**When manual registration is appropriate:**
- Systems where filesystem conventions cannot be enforced (third-party agents, remote agents)
- High-security environments where filesystem scanning is prohibited
- Agents that are ephemeral (running in memory, not backed by persistent files)

**Tradeoffs:**
- **Pro:** Explicit, intentional. No accidental registration of directories that happen to have `.claude/`.
- **Pro:** Enables transient registrations (agents that exist only while a process runs).
- **Con:** Registration requires agent cooperation. Existing Claude Code projects do not self-register.
- **Con:** Registration can get out of sync if the agent exits without deregistering.

**Recommendation for Mesh:** Support manual registration as a secondary mechanism for advanced use cases (programmatic agents, remote federation), but default to automatic discovery via filesystem scanning. The DorkOS server could expose a `POST /api/mesh/register` endpoint for manual registration.

#### 4.4 Hybrid Approach (Recommended)

The optimal Mesh discovery architecture combines all three:

1. **Initial scan** on Mesh startup: walk configured directories, find all `.claude/agent.json` files (or CLAUDE.md with mesh frontmatter)
2. **File watchers** for live updates: chokidar watches the mesh root and all discovered agent directories
3. **Manual registration API** for programmatic/remote agents
4. **Heartbeat/liveness tracking** for running agents: agents can optionally write a PID file or connect to a Unix domain socket to declare they are actively running

This is exactly how systemd works: initial scan of unit directories at startup, with `daemon-reload` triggered by package managers that install new unit files (analogous to the file watcher).

---

### 5. Synthesized Architecture for DorkOS Mesh

#### 5.1 The Agent Manifest: `.claude/agent.json`

Each project directory that wants to participate in Mesh creates `.claude/agent.json`:

```json
{
  "$schema": "https://dorkos.dev/schemas/mesh/agent-card/v1.json",
  "id": "my-project",
  "name": "My Project Agent",
  "version": "1.0.0",
  "description": "Full-stack TypeScript app with React frontend. Expert in React, Node.js, PostgreSQL.",
  "skills": [
    {
      "id": "typescript-review",
      "name": "TypeScript Code Review",
      "description": "Review TypeScript code for quality, types, and best practices",
      "tags": ["typescript", "code-review", "react", "node"]
    },
    {
      "id": "database-migrations",
      "name": "Database Migration Author",
      "description": "Write and review PostgreSQL migrations using Drizzle ORM",
      "tags": ["postgresql", "drizzle", "migrations", "database"]
    }
  ],
  "protocol": {
    "version": "1.0",
    "transport": "unix-socket",
    "socket": ".dork/mesh.sock"
  },
  "capabilities": {
    "streaming": true,
    "tools": ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
    "maxTurns": 100
  },
  "metadata": {
    "cwd": "/Users/alice/projects/my-project",
    "stack": ["typescript", "react", "node", "postgresql"],
    "mesh.routing.priority": "10"
  }
}
```

**Alternatively**, for zero-configuration projects that already have `CLAUDE.md`, Mesh can extract metadata from CLAUDE.md frontmatter (if present) or from a structured `<!-- mesh: -->` HTML comment block.

#### 5.2 Discovery Flow

```
MeshService startup
  │
  ├── Read ~/.dork/mesh-config.json
  │     (configured scan roots, e.g., ~/projects/, ~/work/)
  │
  ├── Walk scan roots
  │     For each directory:
  │       If .claude/agent.json exists → parse and register
  │       Else if .claude/ exists → register with inferred metadata from CLAUDE.md
  │
  ├── Start chokidar watchers on:
  │     - Each scan root (depth: 2, watching for .claude/ directory creation)
  │     - Each registered agent's .claude/ directory (watching for agent.json changes)
  │
  ├── Open Unix domain socket at ~/.dork/mesh.sock
  │     (for agent-to-agent IPC and manual registration)
  │
  └── Start HTTP API at localhost:{MESH_PORT}
        GET  /api/mesh/agents          — list all registered agents
        GET  /api/mesh/agents/:id      — get agent details
        POST /api/mesh/agents          — manual registration
        DELETE /api/mesh/agents/:id    — manual deregistration
        GET  /api/mesh/agents/search   — search by skill tags
        SSE  /api/mesh/events          — live agent lifecycle events
```

#### 5.3 Agent Identity

Agent identity should be stable across restarts. Options:
1. **Directory path hash**: SHA-256 of the canonical project path. Stable as long as the directory doesn't move.
2. **Declared ID in manifest**: `agent.json#id` field. User-controlled, portable (survives directory renames).
3. **Git remote URL**: If the project is a git repo, the remote URL is a stable, globally unique identifier.

**Recommendation:** Use declared ID from manifest if present; fall back to a stable hash of the canonical directory path.

#### 5.4 The Registry: SQLite at ~/.dork/mesh.db

Persist registered agents and their last-seen state in SQLite (consistent with how Pulse already uses `~/.dork/pulse.db`):

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  manifest_path TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'discovered',  -- 'discovered' | 'active' | 'stale'
  capabilities JSON,
  skills JSON,
  last_seen_at INTEGER,
  registered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  event_type TEXT NOT NULL,  -- 'registered' | 'updated' | 'activated' | 'stale' | 'removed'
  occurred_at INTEGER NOT NULL
);
```

This mirrors how DorkOS already handles Pulse schedules and runs.

#### 5.5 Liveness vs. Discovery

Filesystem scanning reveals **discovered** agents (their manifests exist). It does not reveal **active** agents (a Claude Code session is currently running in that directory). These are separate states:

- **Discovered**: `.claude/agent.json` exists. The agent can potentially be invoked.
- **Active**: A DorkOS session is currently running in that agent's working directory. It can receive messages immediately.
- **Stale**: A session was active but the SSE connection closed without deregistration.

Liveness tracking uses existing DorkOS infrastructure: the `AgentManager` already tracks active sessions. Mesh can query `AgentManager` to determine which discovered agents are currently active.

#### 5.6 Capability-Based Routing

When an orchestrator needs an agent for a task, it queries Mesh with a capability descriptor:

```json
{
  "intent": "Review the React component for accessibility issues",
  "tags": ["react", "accessibility", "code-review"],
  "preferActive": true
}
```

Mesh routes by:
1. **Tag matching** (hard filter): only agents with overlapping tags in their skills
2. **Description similarity** (soft rank): fuzzy match of intent against agent/skill descriptions
3. **Active preference**: prefer currently active agents over discovered-but-idle agents
4. **Priority metadata**: `mesh.routing.priority` label for tie-breaking

For v1, simple tag intersection is sufficient. Semantic matching (embeddings) is a future enhancement.

---

### 6. Prior Art Summary Table

| System | Manifest File | Discovery Mechanism | Live Updates | Capability Declaration |
|--------|--------------|--------------------|--------------|-----------------------|
| Consul | Agent config file | HTTP API / config scan | Health checks | Service tags, metadata |
| etcd | None (key-value) | Key range scan | TTL leases + watch | Custom key structure |
| ZooKeeper | None (znodes) | Hierarchical namespace | Ephemeral nodes + watches | Custom node data |
| DNS-SD/mDNS | None | UDP multicast | TTL expiry | TXT records |
| systemd | `.service` files | Directory scan | `daemon-reload` | INI file sections |
| npm | `package.json` | `node_modules/` walk | N/A (build time) | `exports`, `scripts` |
| VS Code | `package.json#contributes` | `~/.vscode/extensions/` scan | Restart required | `contributes` typed map |
| Obsidian | `manifest.json` | `.obsidian/plugins/` scan | Restart required | Untyped manifest |
| Next.js | File name convention | Directory walk | Hot Module Replacement | Reserved filenames |
| Claude Code | `.claude/agents/*.md` | Directory scan | Session restart | YAML frontmatter |
| A2A Protocol | `agent-card.json` | `/.well-known/` + registry | Agent-initiated | `skills` + `capabilities` |
| MCP | None (runtime) | Configuration + `initialize` | N/A (per-connection) | Capability negotiation |
| **Mesh (proposed)** | `.claude/agent.json` | Directory scan + chokidar | File watcher | JSON `skills` + `capabilities` |

---

## Recommendations for DorkOS Mesh v1

**1. Filesystem-First Discovery with Opt-In Manifests**

Do not require `.claude/agent.json` to exist. Instead, treat any directory with `.claude/` as a potentially discoverable agent. Projects that want rich Mesh integration create `.claude/agent.json`. Projects that just have `CLAUDE.md` get basic discovery with inferred metadata.

**2. Mirror the Claude Code Subagent Format**

The `.claude/agents/*.md` YAML frontmatter format is already familiar to Claude Code users. The top-level `.claude/agent.json` for Mesh should use the same field names where possible (`name`, `description`, `tools`, `model`, `skills`). Alignment with existing conventions reduces friction.

**3. Use chokidar for Live Discovery**

DorkOS's existing `session-broadcaster.ts` already uses chokidar for JSONL file watching. The same infrastructure applies. Watch the configured scan roots for new `.claude/` directories and watch existing agent directories for manifest changes.

**4. SQLite Registry for Persistence**

Consistent with Pulse's `pulse.db`, persist the Mesh agent registry in `~/.dork/mesh.db`. This enables the DorkOS UI to show registered agents even when the Mesh watcher is not running.

**5. A2A-Inspired Agent Cards**

Model `.claude/agent.json` on A2A's Agent Card format — it is an open standard with backing from 50+ technology partners and is the emerging consensus for agent interoperability. Use the same `skills` array with `id`, `name`, `description`, and `tags`. Add a Mesh-specific `protocol` section for transport configuration.

**6. Unix Domain Sockets for Agent-to-Agent IPC**

For active agent-to-agent communication (as opposed to discovery), use Unix domain sockets at `.dork/mesh.sock` within each project directory. Unix sockets are faster than TCP loopback for local IPC, and the socket file path is itself a discoverable artifact. This mirrors how systemd communicates with services via `.socket` unit files.

**7. Reserve mDNS for Future Federation**

For v1, Mesh is local-only. Design the agent card format so that each agent can be published as an mDNS service in the future. The `protocol.transport` field should support `"mdns"` as a value alongside `"unix-socket"` and `"http"`.

**8. Three-Level Priority: System > User > Project**

Following systemd's pattern:
- `~/.dork/agents/` — user-level agent defaults, available in all projects
- `.claude/agent.json` — project-level agent declaration (highest priority for this project)
- `~/.dork/mesh-config.json` — global scan roots and mesh-wide defaults

---

## Research Gaps & Limitations

- **Security model for agent-to-agent communication**: This research covers discovery but not authentication. In a local system, filesystem permissions are the natural auth mechanism. Cross-machine federation requires OAuth 2.0 or mTLS.
- **Semantic matching performance**: Vector embedding-based skill matching was not researched in depth. The recommendation for v1 (tag intersection) avoids this complexity, but a production system will need it.
- **Conflict resolution for duplicate agent IDs**: What happens if two projects declare the same `id`? This research identifies the problem but does not provide a definitive resolution strategy.
- **Agent-to-agent message format**: This research covers discovery only. The RPC format for inter-agent requests (JSON-RPC 2.0 per A2A/MCP? Custom SSE protocol? Plain HTTP?) requires separate research.

---

## Contradictions & Disputes

- **Scan-on-startup vs. watch-always**: systemd requires explicit `daemon-reload` after manifest changes (scan-on-demand), while VS Code requires a restart (scan-on-startup). Neither watches live. For a developer tool like Mesh, live watching (chokidar) is clearly superior — developers move directories around, clone new repos, and create projects frequently.
- **Explicit registration vs. implicit discovery**: Consul (explicit) vs. filesystem scanning (implicit). The tradeoff is intentionality vs. zero-friction. For Mesh, the zero-friction argument wins for local discovery, but explicit registration should be available as an override for precise control.

---

## Search Methodology

- Searches performed: 14 web searches + 3 page fetches
- Most productive search terms: "A2A agent discovery", "Claude Code subagents filesystem", ".claude/agents YAML frontmatter", "chokidar vs polling performance", "Consul etcd ZooKeeper service discovery"
- Primary information sources: Google A2A protocol docs (a2a-protocol.org), Claude Code documentation (code.claude.com), MCP specification (modelcontextprotocol.io), Wikipedia, DigitalOcean tutorials

---

## Sources

- [Service Discovery - Consul vs ZooKeeper vs etcd](https://bizety.com/2019/01/17/service-discovery-consul-vs-zookeeper-vs-etcd/)
- [In-Depth Comparison of Distributed Coordination Tools](https://medium.com/@karim.albakry/in-depth-comparison-of-distributed-coordination-tools-consul-etcd-zookeeper-and-nacos-a6f8e5d612a6)
- [etcd versus other key-value stores](https://etcd.io/docs/v3.3/learning/why/)
- [DNS Service Discovery (DNS-SD) Official Site](https://www.dns-sd.org/)
- [RFC 6763 - DNS-Based Service Discovery](https://tools.ietf.org/html/rfc6763)
- [Multicast DNS - Wikipedia](https://en.wikipedia.org/wiki/Multicast_DNS)
- [Zero-configuration networking - Wikipedia](https://en.wikipedia.org/wiki/Zero-configuration_networking)
- [Service Discovery in Kubernetes](https://iximiuz.com/en/posts/service-discovery-in-kubernetes/)
- [Microservices Patterns: Service Discovery Patterns](https://medium.com/cloud-native-daily/microservices-patterns-part-03-service-discovery-patterns-97d603b9a510)
- [Understanding systemd Units and Unit Files](https://www.digitalocean.com/community/tutorials/understanding-systemd-units-and-unit-files)
- [systemd.unit Reference](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html)
- [Extension Manifest - Visual Studio Code API](https://code.visualstudio.com/api/references/extension-manifest)
- [Contribution Points - VS Code API](https://code.visualstudio.com/api/references/contribution-points)
- [Obsidian Manifest Reference](https://docs.obsidian.md/Reference/Manifest)
- [Next.js File-system conventions](https://nextjs.org/docs/app/api-reference/file-conventions)
- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Tool Manifest - Secoda](https://www.secoda.co/glossary/mcp-tool-manifest)
- [chokidar - npm](https://www.npmjs.com/package/chokidar)
- [chokidar - GitHub](https://github.com/paulmillr/chokidar)
- [Announcing the Agent2Agent Protocol (A2A)](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [Agent Discovery - A2A Protocol](https://a2a-protocol.org/latest/topics/agent-discovery/)
- [Agent2Agent protocol upgrade - Google Cloud Blog](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade)
- [What Is Agent2Agent (A2A) Protocol? - IBM](https://www.ibm.com/think/topics/agent2agent-protocol)
- [Agent-Reg: Building an Open Agent Registry for A2A](https://c-daniele.github.io/en/posts/2025-08-15-agent-reg-for-a2a/)
- [RFC 8615 - Well-Known Uniform Resource Identifiers](https://www.rfc-editor.org/rfc/rfc8615)
- [Well-known URIs: Standardizing Web Metadata Discovery](https://rye.dev/blog/well-known-uris-standardizing-web-metadata/)
- [Sidecar Proxy Pattern - The Basis Of Service Mesh](https://iximiuz.com/en/posts/service-proxy-pod-sidecar-oh-my/)
- [Gossip Protocol - Wikipedia](https://en.wikipedia.org/wiki/Gossip_protocol)
- [Create custom subagents - Claude Code Docs](https://code.claude.com/docs/en/sub-agents)
- [Node.js Modules: Packages Documentation](https://nodejs.org/api/packages.html)
- [Object-capability model - Wikipedia](https://en.wikipedia.org/wiki/Object-capability_model)
- [Open Agent Specification (Agent Spec)](https://arxiv.org/html/2510.04173v1)
- [SEP: .well-known/mcp Discovery Endpoint](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1960)
- [Unix domain socket - Wikipedia](https://en.wikipedia.org/wiki/Unix_domain_socket)
- [Revisiting Gossip Protocols for Agentic Multi-Agent Systems](https://arxiv.org/html/2508.01531v1)
