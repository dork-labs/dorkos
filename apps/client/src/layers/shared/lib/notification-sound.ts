let audio: HTMLAudioElement | null = null;

/** Play the notification WAV sound, lazily initializing the audio element. */
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
