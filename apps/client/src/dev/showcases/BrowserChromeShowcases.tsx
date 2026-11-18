import { Fragment, useState } from 'react';
import {
  BrowserChrome,
  BrowserMenu,
  type BrowserChromeProps,
  type BrowserMenuOtherChat,
  type BrowserMenuPage,
} from '@/layers/shared/ui';
import { BrowserStatusPill, type BrowserPillState } from '@/layers/features/local-browser';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/**
 * One chrome at a fixed width over a blank page, with made-up addresses. `testId`
 * marks the cases e2e measures (`apps/e2e/tests/responsive/touch-reach.spec.ts`).
 */
function ChromeDemo({
  width,
  testId,
  ...props
}: Partial<BrowserChromeProps> & { width: number; testId?: string }) {
  const [url, setUrl] = useState(props.url ?? 'https://www.example.com/docs/getting-started');
  return (
    <div
      data-testid={testId}
      className="bg-background overflow-hidden rounded-lg border"
      style={{ width, maxWidth: '100%' }}
    >
      <BrowserChrome
        canBack
        canForward={false}
        onBack={() => {}}
        onForward={() => {}}
        onReload={() => {}}
        {...props}
        url={url}
        onSubmit={(typed) => setUrl(typed)}
      />
      <div className="bg-muted/20 h-24" />
    </div>
  );
}

/** Made-up pages open in one chat: the page and a sign-in popup it opened. */
const PAGES: BrowserMenuPage[] = [
  { id: 'docs', title: 'Getting started · Example Docs', url: 'https://www.example.com/docs' },
  { id: 'popup', title: 'Sign in to Example', url: 'https://accounts.example.com/signin' },
];

/** Made-up chats with a page open; the menu shows only each one's site. */
const OTHER_CHATS: BrowserMenuOtherChat[] = [
  {
    sessionId: 'demo-venue',
    chatTitle: 'Book the venue',
    address: 'https://northwind.example/bookings/42',
    status: 'agent',
  },
  {
    sessionId: 'demo-invoices',
    chatTitle: 'Pay the March invoices',
    address: 'https://billing.example/invoices',
    status: 'waiting',
  },
];

/** The agent asking the person to sign in on a made-up site: the orange Your turn pill. */
const YOUR_TURN: BrowserPillState = {
  kind: 'your-turn',
  site: 'northwind.example',
  reason: 'password',
  handoffId: 'demo',
  askedAt: '2026-11-17T12:00:00.000Z',
};

/**
 * Made-up hosts that try to pass for another site (DOR-4655). At 258px each must
 * keep its site whole; e2e measures them in this order (touch-reach.spec.ts).
 */
const NARROW_HOSTS = [
  'notgoogle.com',
  'evil-google.com',
  'accounts.google.com.attacker.example',
  'login-google.vercel.app',
  'a-very-long-attacker-registrable-name.example',
];

/** The ⋯ menu with every group that can apply, on made-up pages and chats. */
function DemoMenu() {
  const [page, setPage] = useState('docs');
  return (
    <BrowserMenu
      url="https://www.example.com/docs/getting-started"
      pages={PAGES}
      selectedPageId={page}
      onSelectPage={setPage}
      onForward={() => {}}
      canForward
      onOpenExternally={() => {}}
      otherChats={OTHER_CHATS}
      onOpenChat={() => {}}
      onForgetSignIns={() => {}}
      onClose={() => {}}
    />
  );
}

/**
 * The shared browser chrome (DOR-4427): the canvas browser and the Agent
 * browser both wear it. It sizes itself by its own width: from 480px
 * everything shows; below that the path drops and Forward moves into ⋯. On a
 * phone, Reload moves inside the address field.
 */
export function BrowserChromeShowcases() {
  return (
    <PlaygroundSection
      title="Browser chrome"
      description="Back, Forward, Reload and the address, shared by the canvas browser and the Agent browser."
    >
      <ShowcaseLabel>Wide: everything shows (640px)</ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo width={640} menu={<DemoMenu />} />
      </ShowcaseDemo>
      <ShowcaseLabel>Narrow: host only, Forward moves into ⋯ (400px)</ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo width={400} menu={<DemoMenu />} />
      </ShowcaseDemo>
      <ShowcaseLabel>
        Phone (390px): Reload inside the field, pill and ⋯ side by side. Open this page at phone
        width to see it; wider, it shows the narrow row.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo
          width={390}
          testId="browser-chrome-phone-driving"
          status={<BrowserStatusPill state={{ kind: 'driving' }} agentName="Atlas" />}
          menu={<DemoMenu />}
        />
      </ShowcaseDemo>
      <ShowcaseLabel>
        Phone (390px): Your turn keeps its words, and the field gives up room
      </ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo
          width={390}
          testId="browser-chrome-phone-your-turn"
          status={<BrowserStatusPill state={YOUR_TURN} agentName="Atlas" />}
          menu={<DemoMenu />}
        />
      </ShowcaseDemo>
      <ShowcaseLabel>
        Phone, narrow (258px): Your turn goes icon-only below 360px, so the address keeps its room
      </ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo
          width={258}
          testId="browser-chrome-phone-narrow-your-turn"
          status={<BrowserStatusPill state={YOUR_TURN} agentName="Atlas" />}
          menu={<DemoMenu />}
        />
      </ShowcaseDemo>
      <ShowcaseLabel>
        Phone, narrow (258px): Not secure shrinks to an open lock, and nothing runs under Reload
      </ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo
          width={258}
          testId="browser-chrome-phone-narrow-not-secure"
          url="http://printer.example/status"
          menu={<DemoMenu />}
        />
      </ShowcaseDemo>
      <ShowcaseLabel>
        Phone (390px): a long, trusted-looking start is elided; the real site at the end stays whole
      </ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo
          width={390}
          testId="browser-chrome-phone-spoof"
          url="https://accounts.google.com.attacker.example/login"
          menu={<DemoMenu />}
        />
      </ShowcaseDemo>
      <ShowcaseLabel>
        Phone (390px): login-google.vercel.app shows whole, never cut inside a label
      </ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo
          width={390}
          testId="browser-chrome-phone-login-google"
          url="https://login-google.vercel.app/signin"
          status={<BrowserStatusPill state={YOUR_TURN} agentName="Atlas" />}
          menu={<DemoMenu />}
        />
      </ShowcaseDemo>
      <ShowcaseLabel>
        Narrower than its controls (240px): the row scrolls, the address stays pinned in view
      </ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo
          width={240}
          testId="browser-chrome-240-spoof"
          url="https://accounts.google.com.attacker.example/login"
          status={<BrowserStatusPill state={YOUR_TURN} agentName="Atlas" />}
          menu={<DemoMenu />}
        />
      </ShowcaseDemo>
      {NARROW_HOSTS.map((host, index) => (
        <Fragment key={host}>
          <ShowcaseLabel>
            {`Phone, narrow (258px): ${host} keeps its site whole, smaller or wrapped, never clipped`}
          </ShowcaseLabel>
          <ShowcaseDemo>
            <ChromeDemo
              width={258}
              testId={`browser-chrome-phone-narrow-host-${index}`}
              url={`https://${host}/login`}
              status={<BrowserStatusPill state={YOUR_TURN} agentName="Atlas" />}
              menu={<DemoMenu />}
            />
          </ShowcaseDemo>
        </Fragment>
      ))}
      <ShowcaseLabel>Plain http:// off this machine says Not secure</ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo width={640} url="http://printer.example/status" />
      </ShowcaseDemo>
      <ShowcaseLabel>Opened by the http fallback says why it is not secure</ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo width={640} url="http://printer.example/status" openedOverHttp />
      </ShowcaseDemo>
      <ShowcaseLabel>A dev server on this machine keeps its port</ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo width={640} url="http://localhost:5173/settings" />
      </ShowcaseDemo>
      <ShowcaseLabel>A local file on the canvas</ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo width={640} url="demo/index.html" />
      </ShowcaseDemo>
      <ShowcaseLabel>Refused: the notice line, with what was typed kept</ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo
          width={640}
          retry={{ draft: 'file:///Users/kai/notes.html', attempt: 1 }}
          notice="Files don’t open here. Ask the agent to put it on the canvas."
        />
      </ShowcaseDemo>
      <ShowcaseLabel>Loading: Reload becomes Stop</ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo width={640} loading onStop={() => {}} />
      </ShowcaseDemo>
      <ShowcaseLabel>An agent is driving: the seam turns orange</ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo width={640} agentDriving />
      </ShowcaseDemo>
      <ShowcaseLabel>No way to go back or forward yet: both stay disabled</ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo width={640} onBack={undefined} onForward={undefined} />
      </ShowcaseDemo>
      <ShowcaseLabel>The first page in a tab: nowhere to go back or forward</ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo width={640} canBack={false} canForward={false} />
      </ShowcaseDemo>
      <ShowcaseLabel>After going back: Forward has a page again</ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo width={640} canBack={false} canForward />
      </ShowcaseDemo>
      <ShowcaseLabel>A new empty page</ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo width={640} url="about:blank" />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
