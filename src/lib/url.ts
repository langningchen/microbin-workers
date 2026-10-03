/**
 * Returns a normalised http(s) URL if the *whole* text is one URL (so it can become a short link),
 * otherwise `null`. Other schemes (javascript:, data:, file:, ...) are never accepted.
 */
export function parseShortenableUrl(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 2048 || /\s/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') return null;
    return url.href;
  } catch {
    return null;
  }
}
