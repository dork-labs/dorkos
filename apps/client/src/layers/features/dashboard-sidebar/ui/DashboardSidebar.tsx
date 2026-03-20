import {
  SidebarHeader,
  SidebarContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from '@/layers/shared/ui';
import { LayoutDashboard, MessageSquare } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';

/**
 * Dashboard sidebar — navigation and overview for the dashboard route.
 * Placeholder content; full design is a follow-up spec.
 */
export function DashboardSidebar() {
  const navigate = useNavigate();

  return (
    <>
      <SidebarHeader className="border-b p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive
              className="text-foreground flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium"
            >
              <LayoutDashboard className="size-(--size-icon-sm)" />
              Dashboard
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => navigate({ to: '/session' })}
              className="text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all duration-100 active:scale-[0.98]"
            >
              <MessageSquare className="size-(--size-icon-sm)" />
              Sessions
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="flex flex-1 items-center justify-center p-6">
        <p className="text-muted-foreground/60 text-center text-xs">Agent overview coming soon</p>
      </SidebarContent>
    </>
  );
}
