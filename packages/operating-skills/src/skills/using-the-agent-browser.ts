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
and your signed-in browser starts from the save.

## Which browser tools are which

Two sets of tools can both end in \`browser_navigate\`, \`browser_click\` and so on:

- **The signed-in browser** comes from a separate MCP server, usually named
  \`browser\` (in Claude Code its tools read \`mcp__browser__browser_navigate\`).
  It is Playwright, it runs hidden, and it starts signed in. Use it to act on
  websites as the operator.
- **DorkOS's own browser tools** (\`browser_navigate\`, \`browser_read_page\`,
  \`browser_read_console\` and the rest, on the DorkOS server) drive the browser
  a person can watch in the app. It is NOT signed in to anything.

## What you get

- Every signed-in browser starts signed in to the saved sites.
- Nothing you do is saved back. Sign out, clear cookies, sign in somewhere new:
  it is all gone when that browser closes.
- On those sites you act AS the operator. Ask before anything you cannot take
  back (paying, deleting, posting in public, sending messages) unless they
  already told you to.
- Whether your browser is your own depends on the runtime, and only one case
  has been checked. Do not rely on tabs surviving between turns, and do not
  assume another session of you is not using the same browser.

## Passwords and saved sign-ins: never

- Never type a password, a one-time code or a recovery code into a page.
- Never ask the person for a password or code in chat. A transcript keeps it
  forever, and the design exists so you never hold one.
- Never read, print, copy or export the saved sign-ins: not the session file
  (\`storage-state.json\` in the DorkOS data folder), and not the cookies or
  page storage inside your browser. Your browser tools CAN reach them (running
  code, reading request headers); that is exactly why you must not.
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

Your DorkOS context tells you (an \`<agent_browser>\` note) when your browser has
no saved sign-ins, or cannot start at all. Believe it.

To see which sites are saved and until when (names and dates only), run, with
the exact CLI prefix your DorkOS context gives you:
\`dorkos browser status --json\`, or \`dorkos call mcp.browser_preset\`.

## If you have no signed-in browser

The operator gives an agent the signed-in browser from the agent's profile:
Tools & MCP, then Signed-in browser. Ask them to. You can also offer to add it:
take \`server.name\` and \`server.connection\` from \`dorkos call mcp.browser_preset\`
and pass them to \`mcp_add_server\`. That is destructive tier, so the person
approves it at a card showing the exact command, and the tools arrive on your
next session.

Never set up a browser with a persistent profile (\`--user-data-dir\`) instead.
Only one browser can use a profile at a time, so a second agent would fail.`,
};
