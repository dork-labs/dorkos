let audio: HTMLAudioElement | null = null;

export function playNotificationSound(): void {
  try {
    if (!audio) {
      audio = new Audio('/notification.wav');
    }
    audio.currentTime = 0;
    audio.play().catch(() => {
      // Silently ignore autoplay rejection
    });
  } catch {
    // Silently ignore any errors
  }
}
