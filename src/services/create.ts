import { availablePrivacies, allowedExpiries, type Config } from '../config';
import {
  insertPasta,
  isUniqueViolation,
  type NewFile,
  type NewPasta,
  type PastaKind,
} from '../db/pastas';
import { badRequest, forbidden, tooLarge } from '../errors';
import { utf8Length } from '../lib/bytes';
import { expiryTimestamp, isExpiryAllowed } from '../lib/expiry';
import { newId } from '../lib/ids';
import { sanitizeFilename } from '../lib/mime';
import { safeEqual } from '../lib/safe-equal';
import { sealToken } from '../lib/tokens';
import { toB64Url } from '../shared/base64url';
import { BURN_VALUES, MIB, SYNTAX_VALUES } from '../shared/constants';
import { encryptText, importAesKey, KDF_MIN_ITERATIONS, type Bytes } from '../shared/crypto';
import { parseShortenableUrl } from '../lib/url';
import { createCredentials, decodeFixedB64 } from './credentials';
import type { CreateInput } from './schemas';

export const UPLOAD_SESSION_SECONDS = 6 * 3600;
/** Overhead of the "mbx1." envelope: base64 expansion + iv + tag. */
const ENVELOPE_FACTOR = 1.4;

export interface CreatedPasta {
  id: string;
  /** True when nothing else has to be uploaded. */
  complete: boolean;
  /** Present when files still have to be uploaded. */
  token?: string;
  files: { idx: number; mode: 'single' | 'multipart' }[];
}

/** Everything the policy checks decide, before anything is written. */
export interface CreatePlan {
  input: CreateInput;
  expiresAt: number | null;
  syntax: string;
  kind: PastaKind;
  plainContent: string;
}

export function assertMayUpload(
  config: Config,
  uploaderPassword: string | undefined,
): Promise<void> {
  if (!config.readonlyMode) return Promise.resolve();
  const expected = config.uploaderPassword;
  if (!expected) throw forbidden('Uploads are disabled on this server', 'uploads_disabled');
  return safeEqual(uploaderPassword ?? '', expected).then((ok) => {
    if (!ok) throw forbidden('Incorrect uploader password', 'incorrect_uploader_password');
  });
}

export function planCreate(config: Config, input: CreateInput, now: number): CreatePlan {
  if (!availablePrivacies(config).includes(input.privacy)) {
    throw badRequest(`Privacy level "${input.privacy}" is not enabled on this server`);
  }
  const expiration = input.expiration;
  if (!isExpiryAllowed(config, expiration)) {
    const allowed = allowedExpiries(config)
      .map((option) => option.id)
      .join(', ');
    throw badRequest(`Expiration "${expiration}" is not allowed (allowed: ${allowed})`);
  }
  if (!BURN_VALUES.includes(input.burnAfter)) {
    throw badRequest(`burnAfter must be one of ${BURN_VALUES.join(', ')}`);
  }
  if (input.burnAfter !== 0 && !config.enableBurnAfter) {
    throw badRequest('Burn after reads is disabled on this server');
  }
  if (!SYNTAX_VALUES.includes(input.syntax)) throw badRequest(`Unknown syntax "${input.syntax}"`);
  const syntax = config.highlightSyntax ? input.syntax : 'none';

  const encryptedByClient = input.privacy === 'secret';
  const storedLimit = encryptedByClient
    ? Math.ceil(config.maxTextBytes * ENVELOPE_FACTOR) + 1024
    : config.maxTextBytes;
  if (utf8Length(input.content) > storedLimit) {
    throw tooLarge(`Text is larger than ${Math.floor(config.maxTextBytes / 1024)} KiB`);
  }

  // Password requirements per privacy level.
  if ((input.privacy === 'readonly' || input.privacy === 'private') && !input.password) {
    throw badRequest('A password is required for this privacy level', 'password_required');
  }
  if (encryptedByClient) {
    if (!input.kdf) throw badRequest('kdf parameters are required for secret uploads');
    decodeFixedB64(input.kdf.salt, 16, 'kdf.salt');
    decodeFixedB64(input.kdf.verifier, 32, 'kdf.verifier');
    if (!input.content.startsWith('mbx1.')) throw badRequest('Secret content must be encrypted');
  }

  // Files.
  if (input.files.length > 0 && config.noFileUpload) throw badRequest('File uploads are disabled');
  if (input.files.length > config.maxFiles) {
    throw badRequest(`At most ${config.maxFiles} files per upload`);
  }
  const sizeLimit =
    input.privacy === 'private'
      ? Math.min(config.maxFileBytesEncrypted, config.singlePutMaxBytes)
      : encryptedByClient
        ? config.maxFileBytesEncrypted + MIB // ciphertext is slightly larger than the plaintext
        : config.maxFileBytesUnencrypted;
  for (const file of input.files) {
    if (file.size > sizeLimit) {
      throw tooLarge(
        `Files must be smaller than ${Math.floor(sizeLimit / MIB)} MB for ${input.privacy} uploads`,
      );
    }
  }
  if (input.content.trim() === '' && input.files.length === 0) {
    throw badRequest('Nothing to upload: add some text or a file', 'empty');
  }

  // Only plaintext pastas with no files can become short links.
  const plain =
    input.privacy === 'public' || input.privacy === 'unlisted' || input.privacy === 'readonly';
  const kind: PastaKind =
    plain && input.files.length === 0 && parseShortenableUrl(input.content) ? 'url' : 'text';

  return {
    input,
    expiresAt: expiryTimestamp(expiration, now),
    syntax,
    kind,
    plainContent: kind === 'url' ? input.content.trim() : input.content,
  };
}

export async function createPasta(
  env: Pick<Env, 'DB'>,
  config: Config,
  plan: CreatePlan,
  now: number,
): Promise<CreatedPasta> {
  const { input } = plan;

  // Password handling & content encryption.
  let content = plan.plainContent;
  let kdfSalt: string | null = null;
  let kdfIter: number | null = null;
  let verifier: string | null = null;
  let encKey: Bytes | undefined;

  if (input.privacy === 'readonly' || input.privacy === 'private') {
    const credentials = await createCredentials(input.password ?? '', config.pbkdf2Iterations);
    kdfSalt = credentials.salt;
    kdfIter = credentials.iter;
    verifier = credentials.verifier;
    if (input.privacy === 'private') {
      encKey = credentials.encKey;
      if (content !== '') content = await encryptText(await importAesKey(encKey), content);
    }
  } else if (input.privacy === 'secret' && input.kdf) {
    kdfSalt = input.kdf.salt;
    kdfIter = Math.max(KDF_MIN_ITERATIONS, input.kdf.iter);
    verifier = input.kdf.verifier;
  }

  const hasFiles = input.files.length > 0;
  const isSecret = input.privacy === 'secret';
  const files: NewFile[] = input.files.map((file, idx) => ({
    idx,
    // Secret pastas keep their real file names inside the encrypted manifest.
    name: isSecret ? '' : sanitizeFilename(file.name),
    size: file.size,
    r2Key: `f/${crypto.randomUUID()}`,
  }));

  const base: Omit<NewPasta, 'id'> = {
    kind: plan.kind,
    content,
    syntax: plan.syntax,
    privacy: input.privacy,
    editable: config.editable,
    kdfSalt,
    kdfIter,
    verifier,
    createdAt: now,
    expiresAt: plan.expiresAt,
    burnAfterReads: input.burnAfter,
    totalSize: utf8Length(content),
    status: hasFiles ? 'pending' : 'active',
  };

  let id: string;
  for (let attempt = 0; ; attempt++) {
    id = newId(config, input.privacy);
    try {
      await insertPasta(env.DB, { id, ...base }, files);
      break;
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= 5) throw error;
    }
  }

  const result: CreatedPasta = {
    id,
    complete: !hasFiles,
    files: files.map((file) => ({
      idx: file.idx,
      mode: file.size <= config.singlePutMaxBytes ? 'single' : 'multipart',
    })),
  };
  if (hasFiles) {
    result.token = await sealToken(config.sessionSecret, 'upload', {
      id,
      exp: now + UPLOAD_SESSION_SECONDS,
      ...(encKey ? { k: toB64Url(encKey) } : {}),
    });
  }
  return result;
}
