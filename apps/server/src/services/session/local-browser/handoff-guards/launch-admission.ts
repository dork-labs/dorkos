import type { HandoverBrowser } from './handover-browser.js';
import type { prepareHandoffPage } from './prepare-handoff.js';
import { outsideTurnRefusal, type OutsideTurnCheck } from './outside-turn-reason.js';
import type { SignInWindow } from '../sign-in-window.js';
import { prepareProfileFolder } from '../profile-folders.js';
import { assertSignInUrl } from './page-address.js';

/** Async live admission, then a synchronous custody fence immediately before the physical spawn. */
export function handoffLaunchAdmission(
  browser: HandoverBrowser,
  snapshot: ReturnType<typeof prepareHandoffPage>,
  outsideTurn: OutsideTurnCheck,
  assertCustody: () => void
) {
  return {
    require: async () => {
      await browser.requireHandoffAuthority?.(snapshot.chatId);
      const marked = await outsideTurn(snapshot.chatId);
      if (marked !== null && !(marked === 'read_outside_text' && snapshot.refused))
        throw outsideTurnRefusal(marked);
    },
    assertCurrent: () => {
      assertSignInUrl(snapshot.tab.url);
      snapshot.close?.assertClosed();
      assertCustody();
      browser.requireHandoffCustody?.(snapshot.profileId);
      browser.requireExclusiveProfile?.(snapshot.profileId);
    },
  };
}

/** Close only the admitted Page connection, then prepare its same debugger-off window. */
export async function launchHandoffSignIn(
  browser: HandoverBrowser,
  signIns: SignInWindow,
  directory: string,
  snapshot: ReturnType<typeof prepareHandoffPage>,
  admission: ReturnType<typeof handoffLaunchAdmission>
): Promise<void> {
  if (snapshot.close) await snapshot.close.close();
  else await browser.disconnect();
  const folder = await prepareProfileFolder(directory, snapshot.profileId);
  await signIns.start(folder, snapshot.profileId, snapshot.tab.url, admission);
}
