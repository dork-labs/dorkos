import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  Button,
  Drawer,
  DrawerTrigger,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerFooter,
  DrawerClose,
} from '@/layers/shared/ui';

/** Drawer component showcases: bottom sheet panel via vaul. */
export function DrawerShowcases() {
  return (
    <>
      <PlaygroundSection
        title="Drawer"
        description="Bottom sheet panel for mobile-friendly interactions."
      >
        <ShowcaseLabel>Default</ShowcaseLabel>
        <ShowcaseDemo>
          <Drawer>
            <DrawerTrigger asChild>
              <Button variant="outline">Open Drawer</Button>
            </DrawerTrigger>
            <DrawerContent>
              <DrawerHeader>
                <DrawerTitle>Agent Configuration</DrawerTitle>
                <DrawerDescription>Adjust settings for the active agent session.</DrawerDescription>
              </DrawerHeader>
              <div className="text-muted-foreground px-4 pb-4 text-sm">
                Drawer body content goes here.
              </div>
              <DrawerFooter>
                <DrawerClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DrawerClose>
                <DrawerClose asChild>
                  <Button>Save</Button>
                </DrawerClose>
              </DrawerFooter>
            </DrawerContent>
          </Drawer>
        </ShowcaseDemo>

        <ShowcaseLabel>With scrollable content</ShowcaseLabel>
        <ShowcaseDemo>
          <Drawer>
            <DrawerTrigger asChild>
              <Button variant="outline">Open Scrollable Drawer</Button>
            </DrawerTrigger>
            <DrawerContent>
              <DrawerHeader>
                <DrawerTitle>Session History</DrawerTitle>
                <DrawerDescription>
                  Recent agent interactions across all projects.
                </DrawerDescription>
              </DrawerHeader>
              <div className="max-h-60 overflow-y-auto px-4 pb-4">
                {Array.from({ length: 15 }, (_, i) => (
                  <div key={i} className="border-b py-3 text-sm">
                    <p className="font-medium">Session {i + 1}</p>
                    <p className="text-muted-foreground text-xs">
                      agent-{String(i + 1).padStart(3, '0')} — completed 2m ago
                    </p>
                  </div>
                ))}
              </div>
              <DrawerFooter>
                <DrawerClose asChild>
                  <Button variant="outline">Close</Button>
                </DrawerClose>
              </DrawerFooter>
            </DrawerContent>
          </Drawer>
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
