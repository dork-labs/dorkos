### Fixed

- DorkOS now remembers your OpenCode connection. Once you connect OpenCode (through OpenRouter, your own API key, or local models on your computer), it stays ready across page reloads and restarts — no more being asked to sign in again when you already had (DOR-422).

### Added

- The OpenCode model menu now groups a long list into Frontier, Solid coders, and Quick helpers, and marks models that run on your own computer as private (DOR-422).
- The local-models setup now shows the models you already have with an honest "runs well / may be slow / too large" verdict for your hardware, offers a bigger shelf of coding models to pick from, and lets you pull any model by name (DOR-422).
- On Windows and Linux machines with an NVIDIA graphics card, those fit verdicts now account for your GPU memory, not just system memory (DOR-422).
