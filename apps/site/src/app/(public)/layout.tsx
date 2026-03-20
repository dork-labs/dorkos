import { PublicFooter } from '@/layers/shared/ui';

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <main className="flex-1">{children}</main>
      <PublicFooter />
    </div>
  );
}
