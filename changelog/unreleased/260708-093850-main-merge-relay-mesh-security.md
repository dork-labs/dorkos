### Added

- Relay storage now cleans up after itself: expired messages and their files are garbage-collected on a schedule, dead letters are kept for 24 hours and then purged, messages stranded by a crash are redelivered after 30 minutes, and abandoned mailbox directories are reaped after 24 hours (durable inboxes are never touched) — so busy inboxes no longer fill up and permanently stop accepting messages. All windows are tunable via `RelayOptions` (`gcIntervalMs`, `deadLetterRetentionMs`, `orphanMaildirRetentionMs`, `inFlightRecoveryMs`). Agents waiting on a reply now get an immediate error when delivery to the target agent fails, instead of hanging until their timeout.
- Live channel freshness for bindings and adapters over SSE
- Agent namespaces now honor the scan root you picked during discovery — registering an agent records the root it was found under, so namespace-based access control matches your actual project layout. `GET /api/mesh/agents` also returns one consistent shape: health fields always present, project paths never leaked.
- Agents are rediscovered from disk after a database rebuild — delete `dork.db` and the reconciler restores your registry from `.dork/agent.json` files (managed agents home plus your recorded scan roots) on its next pass.

### Changed

- Tighten adapter-change broadcast docs to actual coverage
- New "Integrating via A2A" docs guide (discovery, auth, a working client example), and adapter/mesh docs corrected to match the shipped behavior

### Removed

- The unused `rate_limit_buckets` database table — agent budget limits were never enforced through it; budget fields on agent manifests are advisory metadata for now

### Fixed

- Resolve relay identity from the registered namespace, enforce deny loudly
- Validate manifests on write, log invalid manifests on read
- Publish an error signal before the synthesized done on crash/abort — crashed or TTL-aborted agent turns now fail `relay_send_and_wait` (code `AGENT_ERROR`) and A2A tasks instead of masquerading as successful replies with partial text
- Close GC data-destruction paths from PR #122 review
- Honest copy and design-system cleanup on relay/mesh surfaces
- A11y pass on mesh and relay surfaces
- Background agent rediscovery never scans your home directory — it stays inside the managed agents folder and the scan roots you chose
- Discovery scans no longer abort when one agent manifest sits outside the scan root — the agent is imported with a sensible fallback namespace instead

### Security

- Agent-to-agent messages now carry a server-verified sender identity — the `from` (and `relay_notify_user`'s `agentId`) parameters are gone from the relay tools, so an agent can no longer message as someone else. With identities verified, the default **cross-namespace deny is now actually enforced**: agents in different namespaces cannot message each other until you allow it from the Agents page Access panel (or `PUT /api/mesh/topology/access`). DorkBot keeps working across all namespaces via an automatic system-agent allow rule. A denied send fails with `ACCESS_DENIED` and a hint explaining how to open the path.
- MCP mesh tools (`mesh_register`, `mesh_discover`, `mesh_deny`) now enforce the same directory-boundary validation as the HTTP API and reject invalid runtimes, so callers on the external `/mcp` endpoint can no longer register agents outside the boundary or write unreadable manifests.
