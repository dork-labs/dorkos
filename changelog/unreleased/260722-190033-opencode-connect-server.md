### Fixed

- DorkOS now remembers your OpenCode connection. Once you connect OpenCode (through OpenRouter, your own API key, or local models on your computer), it stays ready across page reloads and restarts. You are no longer asked to sign in again when you already had (DOR-422).

### Added

- OpenCode's model list now comes back grouped into Frontier, Solid coders, and Quick helpers, and sorted for you. Models that run on your own computer are marked as local, and frontier models stay cloud-only (DOR-422).
- You can now pull any Ollama model by name, not just a short preset list. For each model DorkOS gives an honest read on whether it will run well, may be slow, or is too large for your hardware (DOR-422).
- On Windows and Linux machines with an NVIDIA graphics card, those hardware reads now count your GPU memory, not just your system memory (DOR-422).
