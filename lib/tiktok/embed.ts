// TikTok URL helpers — extract the video id and build embed URLs.
// Used by the worker's input validation and by the results screen embed.

const FULL_RE = /tiktok\.com\/(?:@[\w.-]+\/)?(?:video|photo)\/(\d+)/i;
const SHORT_HOSTS = /^(vm|vt|t)\.tiktok\.com$/i;

export function extractVideoId(url: string): string | null {
  const match = FULL_RE.exec(url);
  if (match) return match[1];
  return null;
}

export function isShortUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return SHORT_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

export function isLikelyTikTokUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/tiktok\.com$/i.test(u.hostname) && !SHORT_HOSTS.test(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function embedUrlFor(videoId: string): string {
  return `https://www.tiktok.com/embed/v2/${videoId}`;
}
