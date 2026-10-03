export type ByteRange =
  { kind: 'none' } | { kind: 'range'; start: number; end: number } | { kind: 'unsatisfiable' };

/**
 * Parses a `Range` header (RFC 9110 §14) against a known representation size.
 *
 * R2 silently returns the *whole* object for malformed or out-of-bounds ranges, so the decision
 * between "ignore" (200), "partial" (206) and "unsatisfiable" (416) has to be made here.
 * Only a single `bytes=` range is supported; anything else is ignored, which the RFC allows.
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match) return { kind: 'none' };
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return { kind: 'none' };

  if (first === '') {
    // suffix range: the last N bytes
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (last !== '' && Number(last) < start) return { kind: 'none' }; // invalid, so ignored
  if (start >= size) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end: last === '' ? size - 1 : Math.min(Number(last), size - 1) };
}
