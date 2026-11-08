import { createFileRoute } from '@tanstack/react-router';
import { AppsPage } from '@/layers/widgets/apps-home';
import { TitleBar } from '@/layers/widgets/one-bar';

/** The Apps page's bar: its title, nothing else (search and Get apps are on the page). */
const AppsBar = () => <TitleBar title="Apps" />;

export const Route = createFileRoute('/_shell/apps')({
  staticData: { header: AppsBar },
  component: AppsPage,
});
