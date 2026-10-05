# Private browser egress mechanism

This folder contains private browser traffic forwarding code. The Node socket implementation
starts a loopback listener when a test explicitly calls it. App startup does not mount it.
Task 5.2 remains open for live authority and browser wiring.

The injected mechanism checks a retained browser run before forwarding any bytes.
Its issuer owns one-use renewal permissions and shared quota records.
Matching owner, workspace, browser ID and browser generation share one browser quota across handles and policy renewals.
Unknown old cleanup stays charged against that same lifetime.
A local coverage gap revokes local grants and closes affected circuits; separately known public policy stays distinct.
Buffer and method observations precede the final authority check before each forwarding call.
Closing a socket is an attempt; only an observed close releases its quota.
A timeout keeps unresolved ownership charged. Late cleanup cannot change an earlier uncertain result.

Mocks exercise framing, numeric peer checks, queue limits, renewal, suspension, and cleanup.
Real port-zero tests also exercise HTTP, CONNECT, WebSocket handoff, credential removal,
protected endpoint refusal, revocation, and original socket closure.
They do not prove host inventory completeness, browser isolation, or production readiness.

Node delivers accepted sockets after acquisition. Its implementation retains the original
listener before listening, then captures each delivered original before callbacks run.
Missing client quota stops that intake. The listener charge remains held until the original
listener and every captured socket have actually closed. It does not claim a per-socket
reservation before Node accepts a connection or an OS-wide incoming socket capacity bound.

The server inventory samples original server handles and actual host interfaces. Missing or
uncertain declared listeners close local admission; separately known public policy remains
available. Coverage applies to the configured declarations, not every listener on the host.
Only canonical loopback grants are eligible; observed noncanonical interfaces stay denied.

Production wiring, listener discovery, protected-authority inventory, runtime containment, and browser capacity proofs remain separate gates.
The issuer refuses missing or stale authority evidence. No default authority producer exists.
