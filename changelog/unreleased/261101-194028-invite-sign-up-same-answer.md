---
covers:
  - "fix(spaces): an invitation's sign-up no longer tells anyone which emails have accounts (DOR-2730)"
  - 'fix(spaces): only an empty account gets "Finish joining"; Resend re-sends the invitation''s mail (DOR-2730)'
  - 'fix(spaces): invitation mail bodies name the space with its host (DOR-2730)'
---

### Security

- On a space that sends email, joining through an invitation now asks for your name and email only, then shows "Check your email" whatever address you typed. A new address gets a link to set your password and finish joining. An address that already has an account gets a note to sign in instead. Before, sign-up said when an email already had an account, so anyone with an invitation could check addresses one by one. On a space that doesn't send email, and when someone claims a new space as its owner, sign-up still says when an email already has an account. (DOR-2730)
