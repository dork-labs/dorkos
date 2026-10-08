import { createFileRoute } from '@tanstack/react-router';
import { BrowserPage } from '@/layers/widgets/browser';
import { TitleBar } from '@/layers/widgets/one-bar';

/** Browser admission remains default-off until actual experiment state and auth resolve. */
const BrowserBar = () => <TitleBar title="Shared browser" />;

export const Route = createFileRoute('/_shell/browser')({
  staticData: { header: BrowserBar },
  component: BrowserPage,
});
