import { createFileRoute } from '@tanstack/react-router';
import { ChannelsPage } from '@/layers/widgets/room-view';
import { ChannelsBar } from '@/layers/widgets/one-bar';
import { zodValidator } from '@tanstack/zod-adapter';
import { channelsSearchSchema } from '../app/route-search';

export const Route = createFileRoute('/_shell/channels')({
  staticData: { header: ChannelsBar },
  validateSearch: zodValidator(channelsSearchSchema),
  component: ChannelsPage,
});
