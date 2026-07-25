### Changed

- Contributors can now run the agent evals on their own machine with `pnpm evals:local`. The harness used to demand an API key, so the checks that prove an agent really does what you asked could only run in CI. It now asks the real question, "can this machine reach a model?", and being signed in with `claude auth login` is answer enough. Every run says which credential it used, and a machine with no way to reach a model still stops with a clear error instead of quietly reporting a pass

### Fixed

- Evals that run against a real model can now actually take a turn. Every one of them was refused before it started, because the throwaway folder each eval works in sits outside the folder its test server was allowed to touch
