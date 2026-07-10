### Fixed

- Widgets no longer flash a "couldn't be rendered" error while they're still arriving. When the agent streams a widget (like a game board), the reply sometimes paused at just the wrong spot, and for a split second the chat showed an error card before the widget popped in. Now a widget that's mid-arrival keeps its calm loading shimmer until it's truly done — the error card only appears if the finished widget is genuinely broken.
- The board's self-check now understands a few more ways agents write down the game record — a blank space at the start or end of a row, extra padding, or a trailing line break no longer make it skip a repair it should have made.
