### Added

- Extensions can now subscribe to live host events — session, turn, tool, and relay activity — instead of polling, via `api.events.subscribe`. Events are privacy-safe summaries (a tool's name and status, a turn's duration and tool-call count) and never carry conversation content. Extensions declare which events they listen to in their manifest's `capabilities.events`.
