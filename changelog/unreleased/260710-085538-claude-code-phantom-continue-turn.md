### Fixed

- Stop the stray "No response requested." reply that could appear before your message in a Claude Code session. When you sent a message soon after the last reply — or clicked a widget button — the underlying Claude CLI sometimes slipped in a hidden "Continue from where you left off." turn first. Your messages now always run as the next turn, with nothing in between.
