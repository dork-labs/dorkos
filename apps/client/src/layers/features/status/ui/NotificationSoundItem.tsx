import { Volume2, VolumeOff } from 'lucide-react';

interface NotificationSoundItemProps {
  enabled: boolean;
  onToggle: () => void;
}

/** Status bar toggle button for muting and unmuting notification sounds. */
export function NotificationSoundItem({ enabled, onToggle }: NotificationSoundItemProps) {
  const Icon = enabled ? Volume2 : VolumeOff;
  return (
    <button
      onClick={onToggle}
      className="hover:text-foreground inline-flex items-center gap-1 transition-colors duration-150"
      aria-label={enabled ? 'Mute notification sound' : 'Unmute notification sound'}
      title={enabled ? 'Sound on — click to mute' : 'Sound off — click to unmute'}
    >
      <Icon className="size-(--size-icon-xs)" />
    </button>
  );
}
