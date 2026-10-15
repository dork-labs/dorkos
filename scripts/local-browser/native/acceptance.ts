/** Actual installed public service and scoped-tool acceptance oracle. Import is inert. */
import assert from 'node:assert/strict';
export interface State {
  status: string;
  selectedTabId: string | null;
  mode: string | null;
  channel: string | null;
  browserVersion: string | null;
  tabs: { id: string; url: string; title: string }[];
}
interface Chat {
  sessionId: string;
  sendAndLand(text: string, timeout: number): Promise<void>;
  waitForTurnToEnd(timeout: number): Promise<void>;
  lastAssistantText(): Promise<string>;
}
export interface ArtifactAcceptanceAdapters {
  /** MUST attest PID/start-command/LISTEN port, bootstrap home/config and installed paths BEFORE mutation. */
  attestInstalledServer(): Promise<void>;
  /** Existing reset/seed/scenario routes and ChatPage.goto(draft,test-mode), on this private server only. */
  createScriptedChat(): Promise<Chat>;
  post(route: string, body: unknown): Promise<State>;
  beforeAttachUrl: string;
  duringAttachUrl: string;
  extensionProbe(
    phase: 'before-attach' | 'during-attach' | 'after-detach'
  ): Promise<{ extensionId: string }>;
  guardProof(): Promise<{ ownedPortReads: number; violations: number }>;
  /** Exact per-run nonce and phase; callbacks originate from the fixture's real Save handler. */
  savedCallbacks(): { value: string; cookiePresent: boolean }[];
  /** Poll exact nonce-bound callbacks until the expected count; reject duplicates and wrong values. */
  waitForSavedCallbacks(count: number): Promise<{ value: string; cookiePresent: boolean }[]>;
  assertOwnedChromeAndTabAlive(selectedId: string): Promise<void>;
  /** Approved human UI navigation of the same chosen tab; NOT Playwright opening a replacement page. */
  humanAfterDetachSameTab(): Promise<void>;
  assertAfterDetachCookie(): Promise<void>;
  /** Must enforce the remaining 810-second operation budget, before and after awaits. */
  stage<T>(label: string, run: () => Promise<T>): Promise<T>;
}

/** Exercise actual INSTALLED public service and scripted capability boundary; never imports source Service. */
export async function runInstalledExistingAcceptance(a: ArtifactAcceptanceAdapters) {
  const step = a.stage.bind(a);
  await step('Attest private installed server', () => a.attestInstalledServer());
  const before = await step('Before-attach owned extension', () =>
    a.extensionProbe('before-attach')
  );
  const chat = await step('Create private scripted chat', () => a.createScriptedChat());
  const opened = await step('Installed native consent', () =>
    a.post('/api/local-browser/open', {
      mode: 'existing',
      channel: 'chrome',
      consent: true,
      sessionId: chat.sessionId,
    })
  );
  assert.equal(opened.status, 'connected');
  assert.equal(opened.mode, 'existing');
  assert.equal(opened.channel, 'chrome');
  assert.equal(typeof opened.browserVersion, 'string');
  const actualVersion = opened.browserVersion!;
  const major = Number(actualVersion.split('.')[0]);
  assert(
    Number.isInteger(major) && major >= 144 && major <= 155,
    'Actual attached Chrome must satisfy supported major range144..155'
  );
  assert.equal(opened.selectedTabId, null);
  const matches = opened.tabs.filter((tab) => tab.url === a.beforeAttachUrl);
  assert.equal(matches.length, 1);
  const selectedId = matches[0].id;
  const selected = await step('Choose already-open tab', () =>
    a.post('/api/local-browser/tabs/' + encodeURIComponent(selectedId) + '/select', {})
  );
  assert.equal(selected.selectedTabId, selectedId);
  const moved = await step('Navigate same selected tab', () =>
    a.post('/api/local-browser/navigate', { url: a.duringAttachUrl })
  );
  assert.equal(moved.selectedTabId, selectedId);
  assert.equal(moved.tabs.find((tab) => tab.id === selectedId)?.url, a.duringAttachUrl);
  const during = await step('During-attach extension', () => a.extensionProbe('during-attach'));
  assert.equal(during.extensionId, before.extensionId);
  const guard = await step('Owned channel discovery proof', () => a.guardProof());
  assert(guard.ownedPortReads > 0);
  assert.equal(guard.violations, 0);
  const turn = async (text: string, expected: string) => {
    await step(text, async () => {
      await chat.sendAndLand(text, 30_000);
      await chat.waitForTurnToEnd(30_000);
      assert((await chat.lastAssistantText()).includes(expected));
    });
  };
  assert.equal(a.savedCallbacks().length, 0);
  await turn('Use the installed shared page', 'local-browser: saved; screenshot=image/png');
  assert.deepEqual(
    await step('First independent Save callback', () => a.waitForSavedCallbacks(1)),
    [{ value: 'Scripted local input', cookiePresent: true }]
  );
  await step('Pause installed browser', () => a.post('/api/local-browser/pause', {}));
  await turn('Try while paused', 'local-browser: paused');
  assert.equal(a.savedCallbacks().length, 1);
  await step('Resume installed browser', () => a.post('/api/local-browser/resume', {}));
  await turn('Use it after resuming', 'local-browser: saved; screenshot=image/png');
  assert.deepEqual(
    await step('Second independent Save callback', () => a.waitForSavedCallbacks(2)),
    [
      { value: 'Scripted local input', cookiePresent: true },
      { value: 'Scripted local input', cookiePresent: true },
    ]
  );
  const detached = await step('Detach installed browser', () =>
    a.post('/api/local-browser/disconnect', {})
  );
  assert.equal(detached.status, 'disconnected');
  assert.equal(detached.selectedTabId, null);
  await step('Preserve owned browser/tab', () => a.assertOwnedChromeAndTabAlive(selectedId));
  await step('Human reload same tab after detach', () => a.humanAfterDetachSameTab());
  const after = await step('After-detach extension', () => a.extensionProbe('after-detach'));
  assert.equal(after.extensionId, before.extensionId);
  await step('After-detach owned cookie', () => a.assertAfterDetachCookie());
  return {
    selectedId,
    attachedBrowser: {
      mode: opened.mode,
      channel: opened.channel,
      browserVersion: actualVersion,
      major,
      source: 'actual installed public open response',
    },
    extensionId: before.extensionId,
    guard,
    callbacks: a.savedCallbacks(),
    artifactBackedService: true,
    scriptedProductionTools: true,
    nativePermissionEvidenceRequired: true,
  };
}
