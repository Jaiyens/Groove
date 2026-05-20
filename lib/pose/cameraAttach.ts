// iOS Safari refuses to autoplay a <video> with a fresh srcObject in some
// cases even when `muted + playsInline` are set. This helper waits for the
// video element to load metadata, then calls play(), and reports whether
// playback actually started so the UI can fall back to a tap-to-start button.

export async function attachStream(
  video: HTMLVideoElement,
  stream: MediaStream,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const tryPlay = async () => {
      if (settled) return;
      try {
        await video.play();
        settled = true;
        resolve(true);
      } catch {
        settled = true;
        resolve(false);
      }
    };
    video.srcObject = stream;
    if (video.readyState >= 1) {
      tryPlay();
    } else {
      video.addEventListener('loadedmetadata', tryPlay, { once: true });
      // Fallback timeout — some browsers don't fire loadedmetadata reliably.
      setTimeout(tryPlay, 800);
    }
  });
}
