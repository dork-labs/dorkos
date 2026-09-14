import { BootBlockedScreen } from './BootBlockedScreen';

/**
 * The whole window, when `GET /api/config` will not answer at all.
 *
 * The bundle loaded and React mounted — the inline boot sentinel in
 * `index.html` is right to stay quiet — but the data layer has nothing, so the
 * shell has no honest app to draw. What it drew instead was
 * `<div class="bg-background h-dvh" />`: a black rectangle indistinguishable
 * from the v0.63.0 crash, and after the shell's 3s escape hatch, a first-run
 * overlay that cannot save a single answer it collects (DOR-1475).
 *
 * **"Will not answer" is the whole claim, and the shell has to have tested it.**
 * This screen names a cause — the server is not there, and may still be coming
 * up — so it may only be shown for evidence that fits: a failure that carried no
 * HTTP status (the connection was refused, or the request timed out), or nothing
 * at all past the hang deadline. A reply with a status is a server that IS
 * there, and it gets `ServerErrorScreen` instead (DOR-2035).
 *
 * The copy stays surface-neutral. In the desktop app the server is a child
 * process of the window showing this screen, so "check your network" would be
 * wrong there — and it is the same screen in both places. "It may still be
 * starting up" is true of every surface DorkOS ships.
 */
export function ServerUnreachableScreen() {
  return (
    <BootBlockedScreen
      testId="server-unreachable"
      headline="DorkOS can’t reach its server"
      detail="It may still be starting up. DorkOS keeps checking, and this screen clears as soon as the server answers."
    />
  );
}
