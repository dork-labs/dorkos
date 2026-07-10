### Fixed

- When you click a button or square in a widget (like the tic-tac-toe board), the
  agent now always responds. Before, it sometimes said "no response requested" and
  ignored your click.
- Board games like tic-tac-toe no longer lose track of the game. Each click now
  carries the full board with it, so the agent stops trusting its own faulty memory.
  It rejects moves on squares that are already taken. And it redraws the board
  exactly once per turn, instead of drifting or playing two moves at once.
