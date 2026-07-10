import { MarketingChrome } from '@/layers/features/marketing';

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-cream-primary min-h-screen">
      <MarketingChrome>{children}</MarketingChrome>
    </div>
  );
}
