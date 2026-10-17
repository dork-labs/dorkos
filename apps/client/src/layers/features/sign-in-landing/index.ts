/**
 * The page a browser lands on after signing in to a service DorkOS talks to
 * (an MCP server, OpenRouter): `/signed-in?landing=<id>`. It shows what the
 * sign-in came to and sends the person back to the right DorkOS, the desktop
 * app or this browser.
 *
 * @module features/sign-in-landing
 */
export { SignInLandingPage } from './ui/SignInLandingPage';
