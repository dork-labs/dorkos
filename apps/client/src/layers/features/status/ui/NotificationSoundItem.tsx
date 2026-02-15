import { Volume2, VolumeOff } from 'lucide-react';

interface NotificationSoundItemProps {
  enabled: boolean;
  onToggle: () => void;
}

export function NotificationSoundItem({ enabled, onToggle }: NotificationSoundItemProps) {
  const Icon = enabled ? Volume2 : VolumeOff;
  return (
    <button
      onClick={onToggle}
      className="inline-flex items-center gap-1 hover:text-foreground transition-colors duration-150"
      aria-label={enabled ? 'Mute notification sound' : 'Unmute notification sound'}
      title={enabled ? 'Sound on — click to mute' : 'Sound off — click to unmute'}
    >
      <Icon className="size-(--size-icon-xs)" />
    </button>
  );
}
