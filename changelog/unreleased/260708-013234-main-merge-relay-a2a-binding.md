### Added

- Harden the external A2A surface: DorkOS refuses to expose the A2A gateway on a non-loopback host when no authentication is configured (set `MCP_API_KEY` or enable login), rate-limits the JSON-RPC and card endpoints, gives every agent its own deterministic `/a2a/agents/{id}` endpoint (the fleet endpoint now rejects untargeted messages instead of guessing), keys A2A agent sessions on the caller's `contextId` so distinct contexts get distinct sessions (`contextId` is caller-supplied — treat it as a shared secret, not a per-principal boundary), advertises the spec-standard `http`/`bearer` security scheme, and adds `DORKOS_PUBLIC_URL` to set the card URL advertised behind a proxy or tunnel.

### Changed

- Align ChannelsTab error fallback with channel vocabulary
- Regenerate OpenAPI spec for the honest inbox response schema
- One binding model in entities/binding + topology interaction hardening

### Fixed

- Close stop-during-start race, native flush fallback, required inbound state
- Adapter lifecycle hardening — start races, instance caches, stream overflow
- Address review — trust-model docs, required express peer, roster-free errors
- Finish UpdateBindingRequest single-source-of-truth (review follow-ups)
- Make binding create/edit flows apply what the user configured
- Stop silent message loss in delivery pipeline and agent messaging tools
- Dead-letter unmatched detached deliveries and FIFO inbox paging
