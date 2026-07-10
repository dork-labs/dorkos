### Fixed

- In board games like tic-tac-toe, the agent no longer draws a board that is missing
  its own move. It now works out the new game state first, then draws the board from
  that state, so the two always match.
