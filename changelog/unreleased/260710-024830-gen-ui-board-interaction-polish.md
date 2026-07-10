### Fixed

- Widget interactions in chat now read cleanly instead of leaking raw markup. When you tap a widget the agent rendered — say a square on a tic-tac-toe board — your move shows up right away as a small, tidy chip ("Tic-Tac-Toe · move 1 1"), the same whether you're playing live or reopening the conversation later. Before, a live tap showed nothing until you reloaded, and a reload showed a wall of `<ui_action>` XML.
- A widget can no longer accept a stray double-tap or a click on an old, stale copy. The moment you play, the whole widget locks: your mark lands instantly and every other control goes quiet until the agent replies. Boards from earlier turns stay fully readable but can't be clicked, so an old board can't corrupt a game in progress.
- Board squares now announce themselves to screen readers — "Row 1, column 3: empty — play here" for an open square, "Row 1, column 1: X" for a played one — where before they were unlabeled.

### Changed

- The board widget got a big glow-up. Marks draw themselves as you'd sketch them (X in two strokes, O as a sweep), empty squares preview your mark on hover, a completed line lights up with a stroke through the winning squares, and while the agent is "thinking" the board breathes calmly instead of showing a spinner. Small boards are roomier so games feel deliberate, and past boards settle into elegant, readable history. Every effect respects reduced-motion settings and looks right in light and dark.
