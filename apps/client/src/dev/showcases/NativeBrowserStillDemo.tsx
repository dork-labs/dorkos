import { MoreHorizontal } from 'lucide-react';
import { NativeBrowserStill } from '@/layers/features/local-browser';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/layers/shared/ui';

const WIDTH = 360;
const HEIGHT = 416;

/** A made-up web page, standing in for the still the desktop app captures. */
const MADE_UP_PAGE = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" font-family="Helvetica, Arial, sans-serif">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <rect width="100%" height="48" fill="#1f3a5f"/>
  <text x="20" y="30" fill="#ffffff" font-size="16" font-weight="700">Northwind Supply</text>
  <text x="20" y="84" fill="#111827" font-size="20" font-weight="700">Invoices</text>
  <text x="20" y="106" fill="#6b7280" font-size="12">3 open · last updated today</text>
  ${[
    'INV-1042 · Acme Bakery · $1,200',
    'INV-1043 · Blue Fern Studio · $640',
    'INV-1044 · Kite &amp; Co · $2,310',
  ]
    .map(
      (row, index) => `
  <rect x="20" y="${128 + index * 56}" width="${WIDTH - 40}" height="44" rx="6" fill="#f3f4f6"/>
  <text x="34" y="${155 + index * 56}" fill="#111827" font-size="13">${row}</text>`
    )
    .join('')}
  <rect x="20" y="304" width="140" height="36" rx="6" fill="#2563eb"/>
  <text x="44" y="327" fill="#ffffff" font-size="13" font-weight="700">New invoice</text>
</svg>`)}`;

/**
 * The embedded browser page while an app layer covers it (DOR-4438): the still sits
 * where the page was, and the menu or Settings draw over it. Made-up page; in the
 * desktop app the still is a capture of the real page.
 */
export function NativeBrowserStillDemo() {
  return (
    <div className="bg-background w-fit space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Agent browser</h3>
        <div className="flex items-center gap-1">
          <Dialog>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">
                Settings
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Settings</DialogTitle>
                <DialogDescription>Made-up preferences for this demo.</DialogDescription>
              </DialogHeader>
            </DialogContent>
          </Dialog>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="More">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>Open in a window</DropdownMenuItem>
              <DropdownMenuItem>Copy address</DropdownMenuItem>
              <DropdownMenuItem>Disconnect</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div
        data-slot="native-browser-surface"
        className="bg-muted/20 relative rounded-lg"
        style={{ width: WIDTH, height: HEIGHT }}
      >
        <NativeBrowserStill
          still={{ url: MADE_UP_PAGE, left: 0, top: 0, width: WIDTH, height: HEIGHT }}
        />
      </div>
    </div>
  );
}
