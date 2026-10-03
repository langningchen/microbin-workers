import { MAX_FILE_NAME_LENGTH } from '../shared/constants';
import { extensionOf } from '../shared/filenames';

export { extensionOf, uniqueNames } from '../shared/filenames';

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  json: 'application/json',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

export type FileKind = 'image' | 'video' | 'audio' | 'other';

export function mimeFor(name: string): string {
  return MIME_TYPES[extensionOf(name)] ?? 'application/octet-stream';
}

export function fileKind(name: string): FileKind {
  const mime = mimeFor(name);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'other';
}

/** Types that may be displayed inline. Everything else is always a download. */
export function isInlineSafe(name: string): boolean {
  const mime = mimeFor(name);
  return /^(image|video|audio)\//.test(mime) || mime.startsWith('text/plain');
}

/**
 * Keeps only a harmless base name: no paths, control characters, Windows-reserved characters or
 * bidirectional overrides (which can disguise "exe" as "png").
 */
export function sanitizeFilename(input: string): string {
  const base = input.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, MAX_FILE_NAME_LENGTH);
  return cleaned || 'file';
}

/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback. */
export function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
