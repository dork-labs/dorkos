### Changed

- Relay message details are now honest: `GET /api/relay/messages/:id` returns the message's real per-endpoint delivery breakdown (one shared envelope id joins files, index rows, traces, and dead letters) instead of a placeholder row with a hardcoded status (#125)
- Agent subject parsing no longer guesses: `relay.agent.*` subjects are disambiguated by an explicit runtime-type discriminator, and a project namespace that collides with a runtime type (e.g. a directory named `claude-code`) is deterministically suffixed — with a startup warning naming the old and new subject when an existing agent is affected (#125)

### Fixed

- Cross-namespace access rules shown in the mesh topology are read from a first-class mesh-owned store instead of being reverse-engineered from relay rule strings, so topology can no longer silently desync from enforcement; existing user rules are migrated automatically on first boot (#125)
