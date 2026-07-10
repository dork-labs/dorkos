### Fixed

- When you click a button or square in a generative-UI widget (like the tic-tac-toe
  `board`), the agent now always responds instead of sometimes saying "no response
  requested" — the message it receives tells it to act.
- Turn-based board games (tic-tac-toe and similar) stay honest turn to turn: the agent
  is taught to carry the full board in every click, trust that over its own memory,
  reject a stale or already-occupied move instead of silently corrupting the board, and
  redraw the board exactly once per turn instead of drifting or double-moving.
