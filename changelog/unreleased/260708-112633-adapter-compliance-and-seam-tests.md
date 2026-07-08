### Changed

- The relay adapter compliance suite now catches the adapter bug classes that used to slip through — echo loops, message splitting that produced unbalanced markup, approval cards that broke on hostile tool input, duplicate inbound events, and start/stop races — via opt-in, capability-driven checks that run against each adapter's real code (telegram, slack, webhook, test-mode). See `contributing/relay-adapters.md`.
