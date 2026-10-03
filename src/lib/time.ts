export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const isoUtc = (ts: number): string => new Date(ts * 1000).toISOString();

/** "2026-10-02 08:41 UTC" - the browser upgrades <time> elements to the local zone. */
export function formatUtc(ts: number): string {
  return `${new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const UNITS: [limit: number, size: number, name: string][] = [
  [60, 1, 'second'],
  [3_600, 60, 'minute'],
  [86_400, 3_600, 'hour'],
  [2_592_000, 86_400, 'day'],
  [31_536_000, 2_592_000, 'month'],
  [Infinity, 31_536_000, 'year'],
];

function span(seconds: number): string {
  for (const [limit, size, name] of UNITS) {
    if (seconds < limit) {
      const value = Math.max(1, Math.floor(seconds / size));
      return `${value} ${name}${value === 1 ? '' : 's'}`;
    }
  }
  return '';
}

export function formatAgo(ts: number, now: number): string {
  const delta = now - ts;
  return delta < 5 ? 'just now' : `${span(delta)} ago`;
}

export function formatIn(ts: number, now: number): string {
  const delta = ts - now;
  return delta <= 0 ? 'expired' : `in ${span(delta)}`;
}
