### Fixed

- The board now shows every move the agent has actually made. In rare games the agent recorded its move correctly behind the scenes but forgot to draw it, leaving a square that looked open — you'd click it, the agent would insist its mark was there, and the game fell apart. The board now double-checks itself against the game's own record and draws any mark that's missing (and stops that square from being clickable). It only ever adds missing marks — it never erases or changes anything you can already see.

### Changed

- X and O now have their own colors — X in blue, O in amber — so you can read the board at a glance. The colors are vivid in both light and dark themes and were chosen to stay distinct for colorblind players. If the agent styles a square itself, that styling still wins.
- Friendlier wording on old game boards and buttons. An out-of-date board now says "This board is from an earlier turn — play on the newest one," and an old button says "This one's from an earlier message" — instead of the jargon-y "Superseded" label.
