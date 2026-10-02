# Private browser egress mechanism

This folder is a private research slice. It does not start a server or enable browser access.
There is no real socket intake implementation or port-zero fixture runner here.
Task 5.2 remains open.

The injected mechanism checks a retained browser run before forwarding any bytes.
Its issuer owns one-use renewal permissions and shared quota records.
Matching owner, workspace, browser ID and browser generation share one browser quota across handles and policy renewals.
Unknown old cleanup stays charged against that same lifetime.
A local coverage gap revokes local grants and closes affected circuits; separately known public policy stays distinct.
Buffer and method observations precede the final authority check before each forwarding call.
Closing a socket is an attempt; only an observed close releases its quota.
A timeout keeps unresolved ownership charged. Late cleanup cannot change an earlier uncertain result.

Mocks exercise framing, numeric peer checks, queue limits, renewal, suspension, and cleanup.
They do not prove native socket ownership, host inventory completeness, browser isolation, or production readiness.
A future socket implementation must reserve intake custody before acquisition and report actual closure.
An ordinary post-accept callback cannot meet that contract by destroying an untracked socket.

Production wiring, listener discovery, protected-authority inventory, runtime containment, and browser capacity proofs remain separate gates.
The issuer refuses missing or stale authority evidence. No default authority producer exists.
