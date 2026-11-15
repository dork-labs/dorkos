import { useState } from 'react';
import { ExternalLink, MoreHorizontal } from 'lucide-react';
import { BrowserChrome, ChromeButton, type BrowserChromeProps } from '@/layers/shared/ui';
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

/** The ⋯ menu's place, held by a plain button until the menu is built. */
const MENU_PLACEHOLDER = <ChromeButton label="More" icon={MoreHorizontal} onClick={() => {}} />;

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
          menu={MENU_PLACEHOLDER}
        />
      </ShowcaseDemo>
      <ShowcaseLabel>Narrow: host only, Forward moves into ⋯ (400px)</ShowcaseLabel>
      <ShowcaseDemo>
        <ChromeDemo width={400} menu={MENU_PLACEHOLDER} />
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
      <ShowcaseLabel>No way to go back or forward yet: Coming soon</ShowcaseLabel>
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
