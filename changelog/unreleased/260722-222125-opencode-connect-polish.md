### Changed

- You can now change how OpenCode is powered without disconnecting first. A connected OpenCode shows a Change link that reopens the power-source picker with your current source labeled ("Currently: On your computer (Ollama)"), so switching from your own computer to the cloud, or the other way, is one clear choice (DOR-427).
- The model menu for local (Ollama) models now offers only the models that are actually on your computer, so you never pick one that isn't installed and watch the turn fail. Add more models from the local panel as before (DOR-427).

### Fixed

- When a session's saved model is no longer available (you switched where models come from, or removed one), the model menu now marks it "not available" and asks you to pick another, instead of silently failing (DOR-427).
- If a turn does run against a model that isn't available, you now get a plain message pointing you to the model menu instead of a raw error from behind the scenes (DOR-427).
