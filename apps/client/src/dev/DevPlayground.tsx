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
import {
  LayoutDashboard,
  Palette,
  TextCursorInput,
  Component,
  MessageSquare,
  Blocks,
  Play,
  Sun,
  Monitor,
  Moon,
  Search,
} from 'lucide-react';
import { createPlaygroundTransport } from './playground-transport';
import { ChatPage } from './pages/ChatPage';
import { FeaturesPage } from './pages/FeaturesPage';
import { TokensPage } from './pages/TokensPage';
import { FormsPage } from './pages/FormsPage';
import { ComponentsPage } from './pages/ComponentsPage';
import { OverviewPage } from './pages/OverviewPage';
import { SimulatorPage } from './pages/SimulatorPage';
import { PlaygroundSearch } from './PlaygroundSearch';
import type { Page, PlaygroundSection } from './playground-registry';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

const transport = createPlaygroundTransport();

interface PlaygroundRoute {
  page: Page;
  anchor: string | null;
}

function getRouteFromPath(): PlaygroundRoute {
  const path = window.location.pathname;
  const anchor = window.location.hash.slice(1) || null;

  if (path === '/dev' || path === '/dev/') return { page: 'overview', anchor };
  if (path.startsWith('/dev/tokens')) return { page: 'tokens', anchor };
  if (path.startsWith('/dev/forms')) return { page: 'forms', anchor };
  if (path.startsWith('/dev/components')) return { page: 'components', anchor };
  if (path.startsWith('/dev/chat')) return { page: 'chat', anchor };
  if (path.startsWith('/dev/features')) return { page: 'features', anchor };
  if (path.startsWith('/dev/simulator')) return { page: 'simulator', anchor };
  return { page: 'overview', anchor };
}

interface NavItem {
  id: Page;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const DESIGN_SYSTEM_NAV: NavItem[] = [
  { id: 'tokens', label: 'Tokens', icon: Palette },
  { id: 'forms', label: 'Forms', icon: TextCursorInput },
  { id: 'components', label: 'Components', icon: Component },
];

const FEATURES_NAV: NavItem[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'features', label: 'Features', icon: Blocks },
  { id: 'simulator', label: 'Simulator', icon: Play },
];

/**
 * Scroll the SidebarInset scroll container to the element with the given id.
 *
 * Uses `scrollIntoView` with smooth behavior; falls back silently if the
 * element is not yet in the DOM.
 */
function scrollToSection(id: string): void {
  // Give React a tick to render the target page before scrolling
  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

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
  const [page, setPage] = useState<Page>(() => getRouteFromPath().page);
  const [searchOpen, setSearchOpen] = useState(false);

  // Use `/dev` for the overview page; all other pages use `/dev/<id>`.
  const navigateTo = useCallback((id: Page) => {
    setPage(id);
    history.pushState(null, '', id === 'overview' ? '/dev' : `/dev/${id}`);
  }, []);

  const handleSelect = useCallback((section: PlaygroundSection) => {
    const url = section.page === 'overview' ? '/dev' : `/dev/${section.page}`;
    setPage(section.page);
    history.pushState(null, '', `${url}#${section.id}`);
    scrollToSection(section.id);
  }, []);

  // Sync page state when the user navigates with browser back/forward.
  useEffect(() => {
    const onPopState = () => setPage(getRouteFromPath().page);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Scroll to any hash anchor after the page has rendered.
  useEffect(() => {
    const { anchor } = getRouteFromPath();
    if (anchor) {
      scrollToSection(anchor);
    }
  }, [page]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
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
                    <SidebarMenu>
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          isActive={page === 'overview'}
                          onClick={() => navigateTo('overview')}
                        >
                          <LayoutDashboard className="size-4" />
                          Overview
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    </SidebarMenu>
                  </SidebarGroup>
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
                  <div className="ml-auto flex items-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSearchOpen(true)}
                      className="text-muted-foreground h-7 gap-1.5 px-2 text-xs"
                      aria-label="Search sections (Cmd+K)"
                    >
                      <Search className="size-3.5" />
                      Search
                      <kbd className="bg-muted rounded px-1 py-0.5 font-mono text-[10px]">⌘K</kbd>
                    </Button>
                  </div>
                </header>
                {page === 'overview' && <OverviewPage onNavigate={navigateTo} />}
                {page === 'tokens' && <TokensPage />}
                {page === 'forms' && <FormsPage />}
                {page === 'components' && <ComponentsPage />}
                {page === 'chat' && <ChatPage />}
                {page === 'features' && <FeaturesPage />}
                {page === 'simulator' && <SimulatorPage />}
              </SidebarInset>

              <PlaygroundSearch
                open={searchOpen}
                onOpenChange={setSearchOpen}
                onSelect={handleSelect}
              />
            </SidebarProvider>
          </div>
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}
