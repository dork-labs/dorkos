import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import {
  BrowserChrome,
  BrowserMenu,
  ChromeButton,
  type BrowserChromeProps,
  type BrowserMenuOtherChat,
  type BrowserMenuPage,
} from '@/layers/shared/ui';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** One chrome at a fixed width over a blank page, with made-up addresses. */
function ChromeDemo({ width, ...props }: Partial<BrowserChromeProps> & { width: number }) {
  const [url, setUrl] = useState(props.url ?? 'https://www.example.com/docs/getting-started');
  return (
    <div
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
 * everything shows; below that the path drops and Forward moves into ⋯.
 */
export function BrowserChromeShowcases() {
  return (
    <PlaygroundSection
      title="Browser chrome"
      description="Back, Forward, Reload and the address, shared by the canvas browser and the Agent browser."
    >
      <ShowcaseLabel>Wide: everything shows (640px)</ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo
          width={640}
          trailing={
            <ChromeButton label="Open in system browser" icon={ExternalLink} onClick={() => {}} />
          }
          menu={<DemoMenu />}
        />
      </ShowcaseDemo>
      <ShowcaseLabel>Narrow: host only, Forward moves into ⋯ (400px)</ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo width={400} menu={<DemoMenu />} />
      </ShowcaseDemo>
      <ShowcaseLabel>Plain http:// off this machine says Not secure</ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo width={640} url="http://printer.example/status" />
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
      <ShowcaseLabel>A new empty page</ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo width={640} url="about:blank" />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
