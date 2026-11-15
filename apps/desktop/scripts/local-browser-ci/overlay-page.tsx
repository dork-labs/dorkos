/**
 * CI-only host page for the overlay witness (DOR-4417, DOR-4418).
 *
 * Renders the client's real surface hook beside the real shared Tooltip, Dialog
 * and Drawer, and lets the witness open one layer at a time. Bundled by
 * `smoke-local-browser.ts` against the client's own modules; never shipped.
 */
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/layers/shared/ui/dialog';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/layers/shared/ui/drawer';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/layers/shared/ui/tooltip';
import { useNativeBrowserSurface } from '@/layers/features/local-browser/model/use-native-browser-surface';

type Layer = 'none' | 'tooltip-away' | 'tooltip-over' | 'dialog' | 'drawer';

const noop = () => {};

function Witness() {
  const surface = useRef<HTMLDivElement | null>(null);
  const [layer, setLayer] = useState<Layer>('none');
  (window as unknown as { __overlay: (next: Layer) => void }).__overlay = setLayer;
  useNativeBrowserSurface(surface, 'overlay-witness', true, noop);
  return (
    <TooltipProvider>
      {/* The page's spot: the right half of the window, as the browser panel sits. */}
      <div ref={surface} style={{ position: 'fixed', top: 0, bottom: 0, left: '50%', right: 0 }} />
      <Tooltip open={layer === 'tooltip-away'}>
        <TooltipTrigger style={{ position: 'fixed', left: 20, top: 100, width: 30 }}>
          Help
        </TooltipTrigger>
        <TooltipContent side="right">More about this</TooltipContent>
      </Tooltip>
      <Tooltip open={layer === 'tooltip-over'}>
        <TooltipTrigger
          style={{ position: 'fixed', left: 'calc(50% - 40px)', top: 200, width: 30 }}
        >
          Edge
        </TooltipTrigger>
        <TooltipContent side="right">This one reaches over the page</TooltipContent>
      </Tooltip>
      <Dialog open={layer === 'dialog'}>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Made-up preferences</DialogDescription>
        </DialogContent>
      </Dialog>
      <Drawer open={layer === 'drawer'}>
        <DrawerContent>
          <DrawerTitle>Options</DrawerTitle>
          <DrawerDescription>Made-up choices</DrawerDescription>
        </DrawerContent>
      </Drawer>
    </TooltipProvider>
  );
}

createRoot(document.getElementById('root')!).render(<Witness />);
