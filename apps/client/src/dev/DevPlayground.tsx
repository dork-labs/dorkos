import { useState, useEffect, useCallback } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  TooltipProvider,
  Button,
  Sidebar,
  SidebarProvider,
  SidebarInset,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarTrigger,
  Separator,
} from '@/layers/shared/ui';
import { TransportProvider, useTheme } from '@/layers/shared/model';
import { Palette, Component, MessageSquare, Sun, Monitor, Moon } from 'lucide-react';
import { createPlaygroundTransport } from './playground-transport';
import { ChatPage } from './pages/ChatPage';
import { TokensPage } from './pages/TokensPage';
import { ComponentsPage } from './pages/ComponentsPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

const transport = createPlaygroundTransport();

type Page = 'tokens' | 'components' | 'chat';

function getPageFromPath(): Page {
  const path = window.location.pathname;
  if (path.startsWith('/dev/components')) return 'components';
  if (path.startsWith('/dev/chat')) return 'chat';
  return 'tokens';
}

interface NavItem {
  id: Page;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const DESIGN_SYSTEM_NAV: NavItem[] = [
  { id: 'tokens', label: 'Tokens', icon: Palette },
  { id: 'components', label: 'Components', icon: Component },
];

const FEATURES_NAV: NavItem[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
];

function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <SidebarFooter className="border-t p-2">
      <div className="flex items-center justify-between px-2">
        <span className="text-muted-foreground text-xs">Theme</span>
        <div className="flex gap-0.5">
          <Button
            variant={theme === 'light' ? 'secondary' : 'ghost'}
            size="icon-sm"
            onClick={() => setTheme('light')}
            aria-label="Light theme"
          >
            <Sun className="size-4" />
          </Button>
          <Button
            variant={theme === 'system' ? 'secondary' : 'ghost'}
            size="icon-sm"
            onClick={() => setTheme('system')}
            aria-label="System theme"
          >
            <Monitor className="size-4" />
          </Button>
          <Button
            variant={theme === 'dark' ? 'secondary' : 'ghost'}
            size="icon-sm"
            onClick={() => setTheme('dark')}
            aria-label="Dark theme"
          >
            <Moon className="size-4" />
          </Button>
        </div>
      </div>
    </SidebarFooter>
  );
}

/** Dev-only playground shell with sidebar navigation, rendered at `/dev`. */
export default function DevPlayground() {
  const [page, setPage] = useState<Page>(getPageFromPath);

  const navigateTo = useCallback((id: Page) => {
    setPage(id);
    history.pushState(null, '', `/dev/${id}`);
  }, []);

  useEffect(() => {
    const onPopState = () => setPage(getPageFromPath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <div className="bg-background text-foreground h-dvh">
            <SidebarProvider defaultOpen className="h-full min-h-0">
              <Sidebar variant="inset">
                <SidebarHeader>
                  <h2 className="px-2 text-sm font-semibold">DorkOS Dev</h2>
                </SidebarHeader>
                <SidebarContent>
                  <SidebarGroup>
                    <SidebarGroupLabel>Design System</SidebarGroupLabel>
                    <SidebarMenu>
                      {DESIGN_SYSTEM_NAV.map((item) => (
                        <SidebarMenuItem key={item.id}>
                          <SidebarMenuButton
                            isActive={page === item.id}
                            onClick={() => navigateTo(item.id)}
                          >
                            <item.icon className="size-4" />
                            {item.label}
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroup>
                  <SidebarGroup>
                    <SidebarGroupLabel>Features</SidebarGroupLabel>
                    <SidebarMenu>
                      {FEATURES_NAV.map((item) => (
                        <SidebarMenuItem key={item.id}>
                          <SidebarMenuButton
                            isActive={page === item.id}
                            onClick={() => navigateTo(item.id)}
                          >
                            <item.icon className="size-4" />
                            {item.label}
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroup>
                </SidebarContent>
                <ThemeToggle />
              </Sidebar>

              <SidebarInset className="overflow-y-auto">
                <header className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
                  <SidebarTrigger className="-ml-0.5" />
                  <Separator orientation="vertical" className="mr-1 h-4" />
                  <span className="text-muted-foreground text-xs">Dev Playground</span>
                </header>
                {page === 'tokens' && <TokensPage />}
                {page === 'components' && <ComponentsPage />}
                {page === 'chat' && <ChatPage />}
              </SidebarInset>
            </SidebarProvider>
          </div>
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}
