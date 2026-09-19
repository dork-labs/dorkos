import type { OperatingSkill } from '../pack.js';
import { TOOL_NAME_NOTE } from '../tool-name-note.js';

/**
 * Teaches an agent to use the signed-in browser (spec `agent-browser-sessions`):
 * browse as the operator on the sites they saved, never handle a password, and
 * hand a sign-in page back to the person instead of typing into it.
 *
 * The failure it exists to prevent is not a missing tool. It is an agent that
 * meets a sign-in page and does the helpful-looking thing: asks the person for
 * their password in chat, where it lands in a transcript forever, or tries to
 * fill the form itself. The whole design keeps passwords on the operator's
 * screen, and one cheerful "what's your password?" undoes it.
 */
export const usingTheAgentBrowser: OperatingSkill = {
  name: 'using-the-agent-browser',
  description:
    'Use when you browse a website that needs a sign-in, when a page you opened asks you to ' +
    'sign in, or when the user mentions the signed-in browser or the agent browser. Covers ' +
    'what your browser starts signed in to, why you never type or ask for a password, what to ' +
    'ask the person to run when a sign-in is missing or expired, and how to check which sites ' +
    'are saved.',
  body: `# Using the agent browser

${TOOL_NAME_NOTE}

The operator signs in to websites once, themselves, in the DorkOS "agent
browser" (their own Chrome with an orange frame). DorkOS saves those sign-ins,
and your browser tools start from the save. The browser server is usually named
\`browser\`; its tools end in \`browser_navigate\`, \`browser_snapshot\`,
\`browser_click\` and so on.

## What you get

- Every browser you open starts already signed in to the saved sites.
- It is YOUR browser only. Each session gets its own private, in-memory copy, so
  agents working at the same time never share tabs or collide.
- Nothing you do is saved back. Sign out, clear cookies, sign in somewhere new:
  it all disappears when your browser closes.
- On those sites you act AS the operator. Ask before anything you cannot take
  back (paying, deleting, posting in public, sending messages) unless they
  already told you to.

## Passwords: never

- Never type a password, a one-time code or a recovery code into a page.
- Never ask the person for a password or code in chat. A transcript keeps it
  forever, and the design exists so you never hold one.
- Never read, print or copy the saved session file
  (\`~/.dork/browser/storage-state.json\`). It holds live sign-ins.
- Never start a "sign in with Google" (or similar) flow that asks for a password.

## When a page asks you to sign in

The site is not saved, or its sign-in ran out. Stop and say so, in one message:

1. Name the site you need.
2. Ask the person to run \`dorkos browser login <site>\` in a terminal, sign in,
   and press Enter.
3. Tell them to start a new session with you afterwards (or re-run the task),
   since your current browser started before the new sign-in.

You cannot do this step for them: the command needs a person at the keyboard
and refuses to run without one.

Do not save a sign-in from inside your own browser. It is thrown away when the
browser closes, and it would be a login made without the operator watching.

## Checking what is saved

- Tool: \`mcp_browser_preset\` (observe tier, always runs). Returns \`saved\`, the
  sites with their cookie expiry dates, and \`loginCommand\`. Site names and
  dates only, never a value.
- CLI: \`dorkos browser status --json\`, run with the exact CLI invocation your
  DorkOS context gives you.

Your DorkOS context also tells you when your browser has no saved sign-ins at
all (an \`<agent_browser>\` note). Believe it: every site will ask you to sign in.

## If you have no browser tools

The operator gives an agent the signed-in browser from the agent's profile:
Tools & MCP, then Signed-in browser. Ask them to. You can also offer to add it:
pass the \`server.name\` and \`server.connection\` from \`mcp_browser_preset\` to
\`mcp_add_server\`. That is destructive tier, so the person approves it at a
card showing the exact command, and the tools arrive on your next session.

Never set up a browser with a persistent profile (\`--user-data-dir\`) instead.
Only one browser can use a profile at a time, so a second agent would fail.`,
};
