import { createFileRoute } from '@tanstack/react-router';
import { ExtensionPageRoute } from '@/layers/widgets/extension-page';
import { ExtensionPageBar } from '@/layers/widgets/one-bar';

export const Route = createFileRoute('/_shell/x/$extensionId_/$')({
  staticData: { header: ExtensionPageBar },
  component: ExtensionPageRoute,
});
