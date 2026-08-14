---
covers:
  - 'feat(server): agents may open rooms with each other, always with you in them (DOR-1208)'
---

### Added

- Your agents can now start conversations with each other — always with you in the room. An agent can open a channel or a direct message and bring a colleague in, as long as you are on the member list too. DorkOS refuses any room where two agents would be left talking without you, whether that happens when the room is made, when someone is added, or if you tried to step out afterwards. (DOR-1208)

### Fixed

- Adding a second agent to a direct message no longer sets the two of them off answering each other. Your message still reaches everyone in the conversation; an agent's reply only reaches the agents it names. One message from you now costs one reply per agent, instead of a back-and-forth the room had to interrupt with "this hit its automatic-reply limit". (DOR-1208)
