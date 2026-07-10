### Fixed

- A very fast double-click (or any burst of clicks) on a game board can no longer send more than one move. The first click wins instantly; the rest are ignored. Before, clicks landing in the same instant could all slip through and corrupt the game.
- Boards no longer treat a blank space as a real mark. Some agents write `" "` for an empty square, which used to draw a phantom dot in every empty cell, garble the square's screen-reader name, and — on a completely empty board — declare victory with a stroke through a row of nothing. Blank squares are now truly blank.
- The victory stroke is now what it was meant to be: a thin, softly translucent pen line through the winning squares, colored to match the win (green for a plain win, or the winning squares' own tone). It used to render as a thick black bar that buried the marks beneath it. Verified by eye in light and dark themes, with permanent examples in the dev playground.
