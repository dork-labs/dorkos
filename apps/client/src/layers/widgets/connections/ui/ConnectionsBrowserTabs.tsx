import type { ReactNode } from 'react';
import { YourBrowserPicker } from '@/layers/features/your-browser';
import { useFeatureEnabled } from '@/layers/shared/model';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/layers/shared/ui';

/** Hide the entire discovery surface unless the server explicitly enables it. */
export function ConnectionsBrowserTabs({ children }: { children: ReactNode }) {
  const enabled = useFeatureEnabled('yourBrowser');
  if (!enabled) return children;
  return (
    <Tabs defaultValue="apps">
      <TabsList aria-label="Apps and browsers" className="mb-6 h-auto min-h-13 w-full">
        <TabsTrigger value="apps" className="min-h-11 flex-1">
          Apps
        </TabsTrigger>
        <TabsTrigger value="browsers" className="min-h-11 flex-1">
          Browsers
        </TabsTrigger>
      </TabsList>
      <TabsContent value="browsers">
        <YourBrowserPicker />
      </TabsContent>
      <TabsContent value="apps">{children}</TabsContent>
    </Tabs>
  );
}
