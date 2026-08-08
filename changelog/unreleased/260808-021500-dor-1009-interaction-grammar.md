---
covers:
  - 'feat(client): give every identity surface one interaction grammar'
---

### Changed

- Faces, names, and cards now answer when you point at them. A card on the Team page lifts a little and picks up a hint of that agent's own color. An avatar you can click rings itself in its color. A mention in a room gains a touch more color. Before this, most of these just sat there, and you found out something was clickable by clicking it.
- Clickable faces no longer fade when you hover them. Fading is how the whole app says "you can't use this", so your own avatar and every agent lockup were quietly reading as switched off. They use color now instead.
- You can reach all of it with a keyboard. Anything that responds to the mouse now responds to Tab the same way — a Team card lights up the whole tile when you Tab to it, not just the name — including the agent chip above the chat box, which had no keyboard highlight at all.
- On a Team card, pointing at "by @name" calms the card down, so it is clear you are about to filter the roster rather than open a profile.
- A profile panel carries a thin line in that person or agent's own color when there is something under the header, so you can tell whose panel you have open at a glance.
- "View profile" on a hover card no longer looks like a button on the surfaces where it does not work yet. It only wears the accent color where pressing it actually opens something.
- If you have asked your system for less motion, none of this moves. You get the finished state right away.
