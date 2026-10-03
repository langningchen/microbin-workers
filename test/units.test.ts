import { describe, expect, it } from 'vitest';
import { ConfigError, allowedExpiries, availablePrivacies, readConfig } from '../src/config';
import { formatBytes, utf8Length } from '../src/lib/bytes';
import { ANIMALS, isValidId, randomAnimalId, randomShortId } from '../src/lib/ids';
import {
  contentDisposition,
  fileKind,
  isInlineSafe,
  mimeFor,
  sanitizeFilename,
  uniqueNames,
} from '../src/lib/mime';
import { parseRange } from '../src/lib/range';
import { openToken, sealToken } from '../src/lib/tokens';
import { formatAgo, formatIn, formatUtc } from '../src/lib/time';
import { parseShortenableUrl } from '../src/lib/url';
import { HttpError } from '../src/errors';
import { createSchema, parseOrThrow } from '../src/services/schemas';

const SECRET = 'x'.repeat(48);
const env = (extra: Record<string, unknown> = {}) => ({ SESSION_SECRET: SECRET, ...extra });

describe('configuration', () => {
  it('has sensible defaults', () => {
    const cfg = readConfig(env());
    expect(cfg.defaultExpiry).toBe('24hour');
    expect(cfg.maxExpiry).toBe('1week');
    expect(cfg.pbkdf2Iterations).toBe(100_000);
    expect(cfg.admin).toBeUndefined();
    expect(cfg.basicAuth).toBeUndefined();
    expect(cfg.idLength).toBe(4);
    expect(readConfig(env({ HASH_IDS: true })).idLength).toBe(8);
  });

  it('accepts booleans and numbers as real values or strings', () => {
    expect(readConfig(env({ WIDE: true, QR: 'false', GC_DAYS: '30' })).wide).toBe(true);
    expect(readConfig(env({ QR: 'false' })).qr).toBe(false);
    expect(readConfig(env({ GC_DAYS: '30' })).gcDays).toBe(30);
    expect(readConfig(env({ HIDE_LOGO: 'yes', HIDE_HEADER: 'off' })).hideLogo).toBe(true);
  });

  it('understands the upstream spellings of renamed settings', () => {
    expect(readConfig(env({ HIGHLIGHTSYNTAX: false })).highlightSyntax).toBe(false);
    expect(
      readConfig(env({ HIGHLIGHTSYNTAX: false, HIGHLIGHT_SYNTAX: true })).highlightSyntax,
    ).toBe(true);
    expect(readConfig(env({ PUBLIC_PATH: 'https://bin.example.com/' })).publicUrl).toBe(
      'https://bin.example.com',
    );
    expect(readConfig(env({ SHORT_PATH: 'https://s.example' })).shortUrl).toBe('https://s.example');
    expect(
      readConfig(env({ PUBLIC_URL: 'https://a.example', PUBLIC_PATH: 'https://b.example' }))
        .publicUrl,
    ).toBe('https://a.example');
  });

  it('reports every problem at once instead of failing on the first', () => {
    try {
      readConfig({
        SESSION_SECRET: 'short',
        MAX_EXPIRY: 'soon',
        QR: 'maybe',
        GC_DAYS: -1,
        PUBLIC_URL: 'ftp://x',
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const problems = (error as ConfigError).problems.join('\n');
      expect(problems).toContain('SESSION_SECRET');
      expect(problems).toContain('MAX_EXPIRY');
      expect(problems).toContain('QR');
      expect(problems).toContain('GC_DAYS');
      expect(problems).toContain('PUBLIC_URL');
    }
  });

  it('fails closed on half-configured Basic Auth', () => {
    expect(() => readConfig(env({ BASIC_AUTH_USERNAME: 'me' }))).toThrow(/BASIC_AUTH/);
    expect(() => readConfig(env({ BASIC_AUTH_PASSWORD: 'pw' }))).toThrow(/BASIC_AUTH/);
    expect(
      readConfig(env({ BASIC_AUTH_USERNAME: 'me', BASIC_AUTH_PASSWORD: 'pw' })).basicAuth,
    ).toEqual({ username: 'me', password: 'pw' });
  });

  it('enables the admin panel only when a password is set (no default credentials)', () => {
    expect(readConfig(env({ ADMIN_USERNAME: 'root' })).admin).toBeUndefined();
    expect(readConfig(env({ ADMIN_PASSWORD: 'pw' })).admin).toEqual({
      username: 'admin',
      password: 'pw',
    });
  });

  it('clamps PBKDF2 to what Workers production supports and reports it', () => {
    const cfg = readConfig(env({ PBKDF2_ITERATIONS: 600_000 }));
    expect(cfg.pbkdf2Iterations).toBe(100_000);
    expect(cfg.warnings.join(' ')).toContain('clamped');
    expect(readConfig(env({ PBKDF2_ITERATIONS: 50 })).pbkdf2Iterations).toBe(10_000);
  });

  it('derives the offered expiry and privacy options', () => {
    const cfg = readConfig(env({ MAX_EXPIRY: '3days' }));
    expect(allowedExpiries(cfg).map((o) => o.id)).toEqual([
      '1min',
      '10min',
      '1hour',
      '24hour',
      '3days',
    ]);
    expect(
      allowedExpiries(readConfig(env({ MAX_EXPIRY: 'never' }))).map((o) => o.id),
    ).not.toContain('never');
    expect(
      allowedExpiries(readConfig(env({ MAX_EXPIRY: 'never', ETERNAL_PASTA: true }))).map(
        (o) => o.id,
      ),
    ).toContain('never');
    expect(
      availablePrivacies(
        readConfig(env({ PRIVATE: false, ENABLE_READONLY: false, ENCRYPTION_SERVER_SIDE: false })),
      ),
    ).toEqual(['public', 'secret']);
    const lowered = readConfig(env({ DEFAULT_EXPIRY: '1month' }));
    expect(lowered.defaultExpiry).toBe('1week');
    expect(lowered.warnings.join(' ')).toContain('DEFAULT_EXPIRY');
    expect(
      readConfig(env({ DEFAULT_PRIVACY: 'private', ENCRYPTION_SERVER_SIDE: false })).defaultPrivacy,
    ).toBe('public');
  });

  it('warns about READONLY mode without an uploader password', () => {
    expect(readConfig(env({ READONLY: true })).warnings.join(' ')).toContain('UPLOADER_PASSWORD');
  });
});

describe('ids', () => {
  it('uses 64 distinct animals so that 6 bits map cleanly', () => {
    expect(ANIMALS).toHaveLength(64);
    expect(new Set(ANIMALS).size).toBe(64);
  });

  it('generates well-formed random ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => randomAnimalId(4)));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(isValidId(id)).toBe(true);
    const short = randomShortId(8);
    expect(short).toMatch(/^[1-9A-HJ-NP-Za-km-z]{8}$/);
    expect(isValidId(short)).toBe(true);
  });

  it('rejects malformed ids before they reach the database', () => {
    for (const bad of [
      '',
      'a',
      '../x',
      'a b',
      "x'; DROP TABLE pastas;--",
      'a'.repeat(300),
      'UPPER-case-animals-here',
    ]) {
      expect(isValidId(bad), bad).toBe(false);
    }
  });
});

describe('Range header', () => {
  it('parses single byte ranges against the file size', () => {
    expect(parseRange(null, 100)).toEqual({ kind: 'none' });
    expect(parseRange('bytes=0-9', 100)).toEqual({ kind: 'range', start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ kind: 'range', start: 90, end: 99 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ kind: 'range', start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ kind: 'range', start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ kind: 'range', start: 0, end: 99 });
  });

  it('distinguishes unsatisfiable from ignorable ranges', () => {
    expect(parseRange('bytes=100-', 100).kind).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100).kind).toBe('unsatisfiable');
    expect(parseRange('bytes=0-', 0).kind).toBe('unsatisfiable');
    for (const ignored of [
      'bytes=abc',
      'bytes=10-5',
      'bytes=0-1,5-6',
      'bytes=-',
      'items=0-5',
      '',
    ]) {
      expect(parseRange(ignored, 100).kind, ignored).toBe('none');
    }
  });
});

describe('files', () => {
  it('detects kinds and keeps risky types as downloads', () => {
    expect(fileKind('a.PNG')).toBe('image');
    expect(fileKind('clip.mp4')).toBe('video');
    expect(fileKind('song.mp3')).toBe('audio');
    expect(fileKind('archive.zip')).toBe('other');
    expect(isInlineSafe('a.svg')).toBe(true); // only ever served inside a sandboxed CSP
    expect(isInlineSafe('a.html')).toBe(false);
    expect(isInlineSafe('a.pdf')).toBe(false);
    expect(mimeFor('noextension')).toBe('application/octet-stream');
    expect(mimeFor('.hidden')).toBe('application/octet-stream');
  });

  it('sanitises names', () => {
    expect(sanitizeFilename('../../a/b/c.txt')).toBe('c.txt');
    expect(sanitizeFilename('..\\..\\evil.exe')).toBe('evil.exe');
    expect(sanitizeFilename('.htaccess')).toBe('htaccess');
    expect(sanitizeFilename('a\u0000b\u001fc.txt')).toBe('abc.txt');
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('///')).toBe('file');
    expect(sanitizeFilename('x'.repeat(500))).toHaveLength(200);
    expect(sanitizeFilename('inv\u202Eoice.exe')).toBe('invoice.exe');
  });

  it('builds RFC 6266 content dispositions', () => {
    const header = contentDisposition('attachment', 'naïve "file".txt');
    expect(header).toContain('filename="na_ve _file_.txt"');
    expect(header).toContain("filename*=UTF-8''na%C3%AFve%20%22file%22.txt");
    expect(header).not.toContain('\n');
  });

  it('makes archive names unique', () => {
    expect(uniqueNames(['a.txt', 'a.txt', 'b', 'a.txt', 'b'])).toEqual([
      'a.txt',
      'a (2).txt',
      'b',
      'a (3).txt',
      'b (2)',
    ]);
  });
});

describe('links', () => {
  it('only shortens plain http(s) URLs', () => {
    expect(parseShortenableUrl('https://example.com')).toBe('https://example.com/');
    expect(parseShortenableUrl('  http://example.com/a b ')).toBeNull();
    expect(parseShortenableUrl('https://example.com/path?x=1#frag')).toBe(
      'https://example.com/path?x=1#frag',
    );
    for (const bad of [
      '',
      'example.com',
      'javascript:alert(1)',
      'data:,x',
      'mailto:a@b.c',
      'https://',
      'two https://a.b https://c.d',
      'http://' + 'a'.repeat(3000),
    ]) {
      expect(parseShortenableUrl(bad), bad).toBeNull();
    }
  });
});

describe('sealed tokens', () => {
  const now = 1_800_000_000;

  it('round-trips and carries an optional key', async () => {
    const token = await sealToken(SECRET, 'file', { id: 'pig-dog-cat', exp: now + 60, k: 'abc' });
    expect(await openToken(SECRET, 'file', token, now)).toEqual({
      id: 'pig-dog-cat',
      exp: now + 60,
      k: 'abc',
    });
    expect(token).not.toContain('pig-dog-cat'); // encrypted, not merely signed
  });

  it('rejects expired, forged, mis-typed and foreign tokens', async () => {
    const token = await sealToken(SECRET, 'upload', { id: 'x', exp: now + 60 });
    expect(await openToken(SECRET, 'upload', token, now + 61)).toBeNull();
    expect(await openToken(SECRET, 'file', token, now)).toBeNull(); // wrong kind
    expect(await openToken('y'.repeat(48), 'upload', token, now)).toBeNull(); // other secret
    expect(await openToken(SECRET, 'upload', token.slice(0, -2) + 'AA', now)).toBeNull();
    for (const junk of ['', 'abc', '!!!', null, undefined, 'A'.repeat(10_000)]) {
      expect(await openToken(SECRET, 'upload', junk as string, now)).toBeNull();
    }
  });
});

describe('formatting', () => {
  it('formats sizes, lengths and times', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(1024 * 1024)).toBe('1 MiB');
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MiB');
    expect(utf8Length('aé日😀')).toBe(1 + 2 + 3 + 4);
    expect(formatUtc(0)).toBe('1970-01-01 00:00 UTC');
    expect(formatAgo(100, 103)).toBe('just now');
    expect(formatAgo(0, 7200)).toBe('2 hours ago');
    expect(formatAgo(0, 61)).toBe('1 minute ago');
    expect(formatIn(7200, 0)).toBe('in 2 hours');
    expect(formatIn(0, 5)).toBe('expired');
  });
});

describe('request validation messages', () => {
  const messageFor = (value: unknown): string => {
    try {
      parseOrThrow(createSchema, value);
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
      return (error as HttpError).message;
    }
    throw new Error('expected a validation error');
  };

  it('explains what is wrong in plain words', () => {
    expect(messageFor({})).toBe('expiration is required');
    expect(messageFor({ expiration: '' })).toBe('expiration must be at least 1 characters');
    expect(messageFor({ expiration: '1hour', privacy: 'secretive' })).toBe(
      'privacy must be one of: public, unlisted, readonly, private, secret',
    );
    expect(messageFor({ expiration: '1hour', burnAfter: -3 })).toBe('burnAfter must be at least 0');
    expect(messageFor({ expiration: '1hour', burnAfter: 1.5 })).toBe(
      'burnAfter must be a whole number',
    );
    expect(messageFor({ expiration: '1hour', content: 5 })).toBe('content must be a string');
    expect(messageFor({ expiration: '1hour', admin: true, hax: 1 })).toBe(
      'unknown fields: admin, hax',
    );
    expect(messageFor({ expiration: '1hour', files: [{ name: 'a', size: -1 }] })).toBe(
      'files.0.size must be at least 0',
    );
  });

  it('fills in defaults for optional fields', () => {
    const parsed = parseOrThrow(createSchema, { expiration: '1hour' });
    expect(parsed).toEqual({
      content: '',
      expiration: '1hour',
      burnAfter: 0,
      syntax: 'none',
      privacy: 'public',
      files: [],
    });
  });
});
