### Security

- Live-update connections now require the same scheme (`http` or `https`) as the page that
  opened them when no reverse proxy declares one. This closes a gap where an unusual proxy
  setup could let a plain `http` page open a secure cockpit's stream (DOR-932)
