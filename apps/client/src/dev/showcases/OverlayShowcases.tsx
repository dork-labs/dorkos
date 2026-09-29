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
    </>
  );
}
