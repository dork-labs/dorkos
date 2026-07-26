### Added

- Tell DorkOS to stop asking about one thing. An approval card now carries a third button — "Allow, and stop asking about this for 8 hours" — that covers one agent doing one action, for a stretch of time you choose. Turn it on in Settings, under Security (DOR-501)
- Find and end a standing permission from either of two places: Settings under Security, or the approvals marker in the header, which now shows a quiet count when trust is live. Each one has a **Stop trusting** button (DOR-501)
- Choosing a permission mode that skips prompts now says what it does not cover: actions on DorkOS itself, like removing packages, still ask. The line appears wherever a mode is picked — the session picker, a channel binding, and a scheduled task (DOR-501)

### Changed

- Standing permissions need **Require login** on. Without it DorkOS cannot tell you apart from an agent running on the same computer, so the control is shown but switched off, with the reason and the fix right above it. Turning the feature off ends every permission that is live, and says so before it does (DOR-501)
