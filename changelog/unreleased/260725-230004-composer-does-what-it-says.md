---
covers:
  - 'fix(chat): the composer tells the truth about what it will do (DOR-479)'
---

### Fixed

- The message box only grew when you typed. Anything else that filled it — clicking a queued message to edit it, pressing Up to reach the queue, Escape putting a draft back, a re-run pre-filling a prompt, tapping a suggestion — left a six-line message showing one line, in a box with no scrollbar to tell you the rest was there. The box now fits whatever it is holding, however it got there (DOR-479)
- Editing a queued message and deleting all the text left you stuck: the banner still said "Editing message", and every button vanished. On a phone, with no Escape key, the only way out was the row's X, which deletes the message. The box now offers a plain "Cancel edit" (DOR-479)
- Pressing Escape twice wipes your draft, and it used to be gone for good. Cmd+Z now brings it back (DOR-479)
- Opening a session on a phone popped the on-screen keyboard and scrolled the page every single time. It doesn't any more (DOR-479)
- While an attachment uploaded, the box claimed the agent was replying: the send button turned into a red Stop that did nothing when you pressed it, and if the upload hung, the box stayed stuck in that state forever. It now shows the upload in progress, and waits for it to finish before anything else happens (DOR-479)
- If an attachment failed to upload, your message was deleted along with it. Your words stay in the box so you can try again (DOR-479)
- The dashboard and the welcome conversation showed a greyed-out X for clearing the box that did nothing when clicked. It's gone — pressing Escape twice still clears the box on those screens, and Cmd+Z still brings the text back (DOR-479)
- Typing your very first message on the dashboard and pressing Enter did nothing at all while DorkOS was still finding your agent, with nothing on screen to say why. It now says "Getting your agent ready…" (DOR-479)
- Typing something like `/zzz` that matches no command left "No commands found." on screen and swallowed your Enter, so the message needed two presses to send. One press is enough, and the card goes away when the message sends (DOR-479)
- Making a desktop window narrow — say, to sit beside your editor — quietly changed Enter from "send" to "new line". Enter now depends on the device rather than the window size: it sends anywhere you have a mouse, trackpad, or stylus (including a tablet with a keyboard case), and inserts a line break on a phone or a bare tablet (DOR-479)
- Running `/compact focus on the API changes` while the agent was still replying deleted your instructions and then told you the agent was busy. The text now stays put unless the compaction actually starts, and the box waits for it rather than letting a second Enter run the same thing twice. If the request never comes back, it gives up after 30 seconds and says so, instead of leaving the box stuck (DOR-479)
- When an agent asked you to approve something, the "Queued (N)" panel disappeared for as long as the question was up. The messages were always safe, but nothing said so. A quiet line now tells you how many are waiting (DOR-479)
