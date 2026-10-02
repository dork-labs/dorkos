import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  Button,
  ResponsiveSheet,
  ResponsiveSheetTrigger,
  ResponsiveSheetContent,
  ResponsiveSheetHeader,
  ResponsiveSheetTitle,
  ResponsiveSheetDescription,
  ResponsiveDialog,
  ResponsiveDialogTrigger,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogClose,
  ResponsiveDialogFullscreenToggle,
  InfoTip,
  MoreDetails,
  Label,
  Switch,
} from '@/layers/shared/ui';

/** Application-owned responsive overlays. */
export function OverlayShowcases() {
  return (
    <>
      <PlaygroundSection
        title="ResponsiveSheet"
        description="Right-side panel that docks at a fixed desktop width and goes full-screen on a phone, switching on the 768px breakpoint (useIsMobile). The two demos below force each width explicitly so they're comparable without resizing the window — in the product the switch is automatic."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <ShowcaseLabel>Desktop (sm:max-w-md)</ShowcaseLabel>
            <ShowcaseDemo>
              <ResponsiveSheet>
                <ResponsiveSheetTrigger asChild>
                  <Button variant="outline">Open Desktop Width</Button>
                </ResponsiveSheetTrigger>
                <ResponsiveSheetContent>
                  <ResponsiveSheetHeader>
                    <ResponsiveSheetTitle>Profile</ResponsiveSheetTitle>
                    <ResponsiveSheetDescription>
                      On a desktop viewport this panel docks at a fixed reading width.
                    </ResponsiveSheetDescription>
                  </ResponsiveSheetHeader>
                  <div className="text-muted-foreground px-4 py-4 text-sm">
                    sm:max-w-md — the default above the 768px breakpoint.
                  </div>
                </ResponsiveSheetContent>
              </ResponsiveSheet>
            </ShowcaseDemo>
          </div>
          <div>
            <ShowcaseLabel>Mobile (full width)</ShowcaseLabel>
            <ShowcaseDemo>
              <ResponsiveSheet>
                <ResponsiveSheetTrigger asChild>
                  <Button variant="outline">Open Mobile Width</Button>
                </ResponsiveSheetTrigger>
                {/* Forces the mobile width class so this demo is comparable to
                    the one above without resizing the browser — the product
                    reaches it via useIsMobile() below 768px, not a prop. */}
                <ResponsiveSheetContent className="w-full sm:max-w-full">
                  <ResponsiveSheetHeader>
                    <ResponsiveSheetTitle>Profile</ResponsiveSheetTitle>
                    <ResponsiveSheetDescription>
                      Below 768px the same panel fills the screen instead.
                    </ResponsiveSheetDescription>
                  </ResponsiveSheetHeader>
                  <div className="text-muted-foreground px-4 py-4 text-sm">
                    w-full sm:max-w-full — what a phone gets automatically.
                  </div>
                </ResponsiveSheetContent>
              </ResponsiveSheet>
            </ShowcaseDemo>
          </div>
        </div>
      </PlaygroundSection>

      <PlaygroundSection
        title="ResponsiveDialog"
        description="Dialog on desktop, drawer on mobile. Supports fullscreen toggle."
      >
        <ShowcaseDemo>
          <ResponsiveDialog>
            <ResponsiveDialogTrigger asChild>
              <Button variant="outline">Open Responsive Dialog</Button>
            </ResponsiveDialogTrigger>
            <ResponsiveDialogContent>
              <ResponsiveDialogHeader>
                <ResponsiveDialogTitle>Session Settings</ResponsiveDialogTitle>
                <ResponsiveDialogDescription>
                  Configure the current session. On mobile, this renders as a bottom drawer.
                </ResponsiveDialogDescription>
                <ResponsiveDialogFullscreenToggle />
              </ResponsiveDialogHeader>
              <div className="text-muted-foreground py-4 text-sm">
                Responsive dialog body content.
              </div>
              <ResponsiveDialogFooter>
                <ResponsiveDialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </ResponsiveDialogClose>
                <ResponsiveDialogClose asChild>
                  <Button>Save</Button>
                </ResponsiveDialogClose>
              </ResponsiveDialogFooter>
            </ResponsiveDialogContent>
          </ResponsiveDialog>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="InfoTip"
        description="Rung 3 of the copy overflow ladder: a quiet info icon after a label that opens a short note. Click or tap opens it, never hover, so it works by keyboard and on touch. Popover on desktop, drawer on a phone."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <ShowcaseLabel>After a setting label</ShowcaseLabel>
            <ShowcaseDemo>
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="infotip-demo-switch">Keep agents running</Label>
                  <InfoTip label="About background agents">
                    <p>They finish their work after you close the app.</p>
                    <p>You get a message when each one is done.</p>
                  </InfoTip>
                </div>
                <Switch id="infotip-demo-switch" />
              </div>
            </ShowcaseDemo>
          </div>
          <div>
            <ShowcaseLabel>With a title</ShowcaseLabel>
            <ShowcaseDemo>
              <div className="flex items-center gap-1.5 text-sm font-medium">
                Asks in the chat
                <InfoTip label="About asking in the chat" title="Where asks appear">
                  <p>Telegram and Slack show Approve and Deny buttons.</p>
                  <p>Other apps get a link back to DorkOS.</p>
                </InfoTip>
              </div>
            </ShowcaseDemo>
          </div>
        </div>
      </PlaygroundSection>

      <PlaygroundSection
        title="MoreDetails"
        description="Rung 3 of the copy overflow ladder, in the page flow: an inline toggle under a short description that reveals extra paragraphs. The chevron and the reveal stand still under reduced motion."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <ShowcaseLabel>Default labels</ShowcaseLabel>
            <ShowcaseDemo>
              <div className="space-y-1">
                <p className="text-sm font-medium">Asks in the chat</p>
                <p className="text-muted-foreground text-sm">
                  Approve or deny from the chat itself.
                </p>
                <MoreDetails>
                  <p>Telegram and Slack show Approve and Deny buttons.</p>
                  <p>Other apps get a link back to DorkOS.</p>
                </MoreDetails>
              </div>
            </ShowcaseDemo>
          </div>
          <div>
            <ShowcaseLabel>Custom labels, open</ShowcaseLabel>
            <ShowcaseDemo>
              <div className="space-y-1">
                <p className="text-sm font-medium">Turn limit</p>
                <p className="text-muted-foreground text-sm">Agents stop after 20 replies.</p>
                <MoreDetails label="Why a limit" openLabel="Hide" defaultOpen>
                  <p>Two agents can answer each other forever.</p>
                  <p>The limit stops that and saves your usage.</p>
                </MoreDetails>
              </div>
            </ShowcaseDemo>
          </div>
        </div>
      </PlaygroundSection>
    </>
  );
}
