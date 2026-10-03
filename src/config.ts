/**
 * Typed, validated configuration.
 *
 * Variables come from `vars` in wrangler.jsonc (strings, numbers or booleans are all accepted so
 * the Cloudflare dashboard, `.dev.vars` and JSON all work). Passwords and the session secret are
 * Worker secrets. Misconfiguration fails closed: every problem is collected and reported at once.
 */
import {
  BURN_VALUES,
  EXPIRY_IDS,
  EXPIRY_OPTIONS,
  MIB,
  PRIVACY_LEVELS,
  VIEW_MODES,
  type ExpiryId,
  type Privacy,
  type ViewMode,
} from './shared/constants';
import { KDF_MIN_ITERATIONS, KDF_SERVER_MAX_ITERATIONS } from './shared/crypto';

export interface Config {
  title: string;
  footerText: string;
  hideHeader: boolean;
  hideFooter: boolean;
  hideLogo: boolean;
  wide: boolean;
  customCss: string;
  publicUrl: string;
  shortUrl: string;

  noListing: boolean;
  noFileUpload: boolean;
  qr: boolean;
  showReadStats: boolean;
  highlightSyntax: boolean;
  editable: boolean;
  enableBurnAfter: boolean;
  defaultBurnAfter: number;
  hashIds: boolean;
  /** Words (animal ids) or characters (hash ids) per id. */
  idLength: number;
  defaultView: ViewMode;

  privateEnabled: boolean;
  enableReadonly: boolean;
  encryptionServerSide: boolean;
  encryptionClientSide: boolean;
  defaultPrivacy: Privacy;

  defaultExpiry: ExpiryId;
  maxExpiry: ExpiryId;
  eternalPasta: boolean;
  gcDays: number;

  maxTextBytes: number;
  maxFiles: number;
  maxFileBytesUnencrypted: number;
  maxFileBytesEncrypted: number;
  /** Files up to this size are uploaded with one request, bigger ones in R2 multipart parts. */
  singlePutMaxBytes: number;
  /** Size of one multipart part (R2 needs >= 5 MiB for all parts but the last). */
  partBytes: number;
  pbkdf2Iterations: number;

  /** READONLY=true: creating uploads requires the uploader password. */
  readonlyMode: boolean;
  uploaderPassword: string | undefined;
  basicAuth: { username: string; password: string } | undefined;
  admin: { username: string; password: string } | undefined;
  sessionSecret: string;

  /** Non-fatal findings, shown on the admin page. */
  warnings: string[];
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

type Raw = Record<string, unknown>;

class Reader {
  readonly problems: string[] = [];
  readonly warnings: string[] = [];
  constructor(private readonly raw: Raw) {}

  private value(name: string): unknown {
    const value = this.raw[name];
    return value === undefined || value === null ? '' : value;
  }

  string(name: string, fallback = ''): string {
    const value = this.value(name);
    if (typeof value === 'string') return value.trim() || fallback;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    this.problems.push(`${name} must be a string`);
    return fallback;
  }

  secret(name: string): string | undefined {
    return this.string(name) || undefined;
  }

  bool(name: string, fallback: boolean): boolean {
    const value = this.value(name);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const text = value.trim().toLowerCase();
      if (text === '') return fallback;
      if (['true', '1', 'yes', 'on'].includes(text)) return true;
      if (['false', '0', 'no', 'off'].includes(text)) return false;
    }
    this.problems.push(`${name} must be true or false`);
    return fallback;
  }

  int(name: string, fallback: number, min: number, max: number): number {
    const value = this.value(name);
    if (value === '') return fallback;
    const parsed = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      this.problems.push(`${name} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return parsed;
  }

  oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
    const value = this.string(name);
    if (value === '') return fallback;
    if ((allowed as readonly string[]).includes(value)) return value as T;
    this.problems.push(`${name} must be one of: ${allowed.join(', ')}`);
    return fallback;
  }

  httpUrl(name: string): string {
    const value = this.string(name);
    if (!value) return '';
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:')
        return url.href.replace(/\/+$/, '');
    } catch {
      /* fall through */
    }
    this.problems.push(`${name} must be an absolute http(s) URL`);
    return '';
  }

  stylesheet(name: string): string {
    const value = this.string(name);
    if (!value) return '';
    if (value.startsWith('/') && !value.startsWith('//')) return value;
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch {
      /* fall through */
    }
    this.problems.push(`${name} must be an http(s) URL or a path starting with "/"`);
    return '';
  }
}

export function readConfig(raw: Raw): Config {
  const r = new Reader(raw);

  const hashIds = r.bool('HASH_IDS', false);
  const idLengthRaw = r.int('ID_LENGTH', 0, 0, 64);
  const idLength = hashIds
    ? Math.min(32, Math.max(6, idLengthRaw || 8))
    : Math.min(12, Math.max(2, idLengthRaw || 4));
  if (idLengthRaw && idLength !== idLengthRaw) {
    r.warnings.push(`ID_LENGTH=${idLengthRaw} was adjusted to ${idLength}.`);
  }

  const privateEnabled = r.bool('PRIVATE', true);
  const enableReadonly = r.bool('ENABLE_READONLY', true);
  const encryptionServerSide = r.bool('ENCRYPTION_SERVER_SIDE', true);
  const encryptionClientSide = r.bool('ENCRYPTION_CLIENT_SIDE', true);
  const available: Privacy[] = PRIVACY_LEVELS.filter(
    (level) =>
      level === 'public' ||
      (level === 'unlisted' && privateEnabled) ||
      (level === 'readonly' && enableReadonly) ||
      (level === 'private' && encryptionServerSide) ||
      (level === 'secret' && encryptionClientSide),
  );
  let defaultPrivacy = r.oneOf('DEFAULT_PRIVACY', PRIVACY_LEVELS, 'public');
  if (!available.includes(defaultPrivacy)) {
    r.warnings.push(`DEFAULT_PRIVACY=${defaultPrivacy} is disabled; falling back to public.`);
    defaultPrivacy = 'public';
  }

  const maxExpiry = r.oneOf('MAX_EXPIRY', EXPIRY_IDS, '1week');
  let defaultExpiry = r.oneOf('DEFAULT_EXPIRY', EXPIRY_IDS, '24hour');
  if (EXPIRY_IDS.indexOf(defaultExpiry) > EXPIRY_IDS.indexOf(maxExpiry)) {
    r.warnings.push(`DEFAULT_EXPIRY=${defaultExpiry} exceeds MAX_EXPIRY=${maxExpiry}; lowered.`);
    defaultExpiry = maxExpiry;
  }
  const eternalPasta = r.bool('ETERNAL_PASTA', false);
  if (eternalPasta && maxExpiry !== 'never') {
    r.warnings.push('ETERNAL_PASTA=true has no effect unless MAX_EXPIRY=never.');
  }
  if (defaultExpiry === 'never' && !eternalPasta) {
    r.warnings.push('DEFAULT_EXPIRY=never requires ETERNAL_PASTA=true; using 1week.');
    defaultExpiry = '1week';
  }

  const defaultBurnAfter = r.int('DEFAULT_BURN_AFTER', 0, 0, 10_000);
  if (!BURN_VALUES.includes(defaultBurnAfter)) {
    r.problems.push(`DEFAULT_BURN_AFTER must be one of: ${BURN_VALUES.join(', ')}`);
  }

  const requestedIterations = r.int('PBKDF2_ITERATIONS', KDF_SERVER_MAX_ITERATIONS, 1, 10_000_000);
  const pbkdf2Iterations = Math.min(
    KDF_SERVER_MAX_ITERATIONS,
    Math.max(KDF_MIN_ITERATIONS, requestedIterations),
  );
  if (pbkdf2Iterations !== requestedIterations) {
    r.warnings.push(
      `PBKDF2_ITERATIONS=${requestedIterations} was clamped to ${pbkdf2Iterations} ` +
        `(Cloudflare Workers rejects more than ${KDF_SERVER_MAX_ITERATIONS}).`,
    );
  }

  const basicUser = r.string('BASIC_AUTH_USERNAME');
  const basicPass = r.secret('BASIC_AUTH_PASSWORD');
  if (Boolean(basicUser) !== Boolean(basicPass)) {
    r.problems.push('BASIC_AUTH_USERNAME and BASIC_AUTH_PASSWORD must be set together');
  }
  const adminPass = r.secret('ADMIN_PASSWORD');
  const readonlyMode = r.bool('READONLY', false);
  const uploaderPassword = r.secret('UPLOADER_PASSWORD');
  if (readonlyMode && !uploaderPassword) {
    r.warnings.push('READONLY=true without UPLOADER_PASSWORD: nobody can create uploads.');
  }

  const sessionSecret = r.secret('SESSION_SECRET') ?? '';
  if (sessionSecret.length < 32) {
    r.problems.push(
      'SESSION_SECRET is required and must be at least 32 characters (wrangler secret put SESSION_SECRET)',
    );
  }

  const config: Config = {
    title: r.string('TITLE'),
    footerText: r.string('FOOTER_TEXT'),
    hideHeader: r.bool('HIDE_HEADER', false),
    hideFooter: r.bool('HIDE_FOOTER', false),
    hideLogo: r.bool('HIDE_LOGO', false),
    wide: r.bool('WIDE', false),
    customCss: r.stylesheet('CUSTOM_CSS'),
    // PUBLIC_PATH / SHORT_PATH are the upstream spellings of the same two settings
    publicUrl: r.httpUrl('PUBLIC_URL') || r.httpUrl('PUBLIC_PATH'),
    shortUrl: r.httpUrl('SHORT_URL') || r.httpUrl('SHORT_PATH'),

    noListing: r.bool('NO_LISTING', false),
    noFileUpload: r.bool('NO_FILE_UPLOAD', false),
    qr: r.bool('QR', true),
    showReadStats: r.bool('SHOW_READ_STATS', true),
    // upstream spells it HIGHLIGHTSYNTAX
    highlightSyntax: r.bool('HIGHLIGHT_SYNTAX', r.bool('HIGHLIGHTSYNTAX', true)),
    editable: r.bool('EDITABLE', true),
    enableBurnAfter: r.bool('ENABLE_BURN_AFTER', true),
    defaultBurnAfter,
    hashIds,
    idLength,
    defaultView: r.oneOf('DEFAULT_VIEW', VIEW_MODES, 'gallery'),

    privateEnabled,
    enableReadonly,
    encryptionServerSide,
    encryptionClientSide,
    defaultPrivacy,

    defaultExpiry,
    maxExpiry,
    eternalPasta,
    gcDays: r.int('GC_DAYS', 90, 0, 36_500),

    maxTextBytes: r.int('MAX_TEXT_KB', 1024, 1, 1400) * 1024,
    maxFiles: r.int('MAX_FILES', 20, 1, 100),
    maxFileBytesUnencrypted: r.int('MAX_FILE_SIZE_UNENCRYPTED_MB', 2048, 1, 5_000_000) * MIB,
    maxFileBytesEncrypted: r.int('MAX_FILE_SIZE_ENCRYPTED_MB', 256, 1, 5_000_000) * MIB,
    singlePutMaxBytes: r.int('UPLOAD_SINGLE_MAX_MB', 64, 1, 90) * MIB,
    partBytes: r.int('UPLOAD_PART_MB', 32, 5, 90) * MIB,
    pbkdf2Iterations,

    readonlyMode,
    uploaderPassword,
    basicAuth: basicUser && basicPass ? { username: basicUser, password: basicPass } : undefined,
    admin: adminPass
      ? { username: r.string('ADMIN_USERNAME', 'admin'), password: adminPass }
      : undefined,
    sessionSecret,
    warnings: r.warnings,
  };

  if (r.problems.length > 0) throw new ConfigError(r.problems);
  return config;
}

// ── Derived helpers ──

export function availablePrivacies(config: Config): Privacy[] {
  return PRIVACY_LEVELS.filter(
    (level) =>
      level === 'public' ||
      (level === 'unlisted' && config.privateEnabled) ||
      (level === 'readonly' && config.enableReadonly) ||
      (level === 'private' && config.encryptionServerSide) ||
      (level === 'secret' && config.encryptionClientSide),
  );
}

/** Expiry choices up to MAX_EXPIRY ("never" additionally needs ETERNAL_PASTA). */
export function allowedExpiries(config: Config) {
  const maxIndex = EXPIRY_IDS.indexOf(config.maxExpiry);
  return EXPIRY_OPTIONS.filter(
    (option, index) => index <= maxIndex && (option.id !== 'never' || config.eternalPasta),
  );
}

const cache = new WeakMap<object, Config>();

/** Parses the environment once per `env` object (per isolate), not per request. */
export function configFor(env: object): Config {
  const cached = cache.get(env);
  if (cached) return cached;
  const config = readConfig(env as Raw);
  cache.set(env, config);
  return config;
}
