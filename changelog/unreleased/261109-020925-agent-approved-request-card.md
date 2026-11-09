---
covers:
  - 'feat(client): a request another agent approved says who approved it, and stays in Needs you for the day'
  - "feat(approvals): asking you to let one agent approve another's request names the agent and the app"
  - 'feat(db): the access-change ledger keeps who approved, and finds an approval by its request'
  - "fix(connectors): a request card reads who approved it from the request itself, and keeps the request's header"
---

### Changed

- **A request another agent approved says so.** The card still shows who asked and for which app. Under that it reads "Approved by DorkOS PM · Read only", with that agent's picture and the time. It stays in Needs you for a day, then you'll find it in Activity.
- **It shows the agent as it was when it approved.** If the agent changes its name later, the card doesn't change. If you undo the approval, the card says "Undone by you".
- **A request for write access says "Write access needs you."** It sits above the buttons. Agents can only approve Read, so only you can answer it.
- **When an agent asks to approve another agent's request, you see names, not codes.** The card shows which agent asked, with its picture, and which app. The request's code is behind the ⓘ button.
