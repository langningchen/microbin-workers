import type { Config } from '../config';
import { findActive, isBurned, type FileRow, type PastaRow } from '../db/pastas';
import { HttpError, notFound, unauthorized } from '../errors';
import { sealToken, openToken } from '../lib/tokens';
import { toB64Url } from '../shared/base64url';
import {
  decryptText,
  importAesKey,
  plaintextSize,
  CryptoError,
  type Bytes,
} from '../shared/crypto';
import { unlockWithPassword } from './credentials';

/** Lifetime of the links on a rendered page (matters for private / burn-after-reads pastas). */
export const FILE_LINK_SECONDS = 60 * 60;

/** A paste that exists, has not expired and still has reads left. */
export async function loadReadable(db: D1Database, id: string, now: number): Promise<PastaRow> {
  const pasta = await findActive(db, id, now);
  if (!pasta || isBurned(pasta)) throw notFound();
  return pasta;
}

/** Verifies a password for `private` / `readonly` pastas and returns the AES key. */
export async function requirePassword(
  pasta: PastaRow,
  password: string | undefined,
): Promise<Bytes> {
  if (!password) throw unauthorized('Password required', 'password_required');
  const key = await unlockWithPassword(pasta, password);
  if (!key) throw unauthorized('Incorrect password', 'incorrect_password');
  return key;
}

/** Plain text of a paste. Only `private` pastas are encrypted on the server. */
export async function readText(pasta: PastaRow, encKey: Bytes | null): Promise<string> {
  if (pasta.privacy !== 'private' || pasta.content === '') return pasta.content;
  if (!encKey) throw unauthorized('Password required', 'password_required');
  try {
    return await decryptText(await importAesKey(encKey), pasta.content);
  } catch (error) {
    if (error instanceof CryptoError) {
      throw new HttpError(500, 'corrupt_content', 'Stored content could not be decrypted');
    }
    throw error;
  }
}

export interface DisplayFile {
  idx: number;
  name: string;
  /** Size of the original file. */
  size: number;
}

export function displayFiles(pasta: PastaRow, files: FileRow[]): DisplayFile[] {
  return files.map((file) => ({
    idx: file.idx,
    name: file.name,
    size:
      pasta.privacy === 'private' || pasta.privacy === 'secret'
        ? (plaintextSize(file.size) ?? file.size)
        : file.size,
  }));
}

/**
 * Links on a rendered page need a token when the file endpoint could not otherwise serve them:
 * private files need the decryption key, secret files prove that the holder unlocked the upload
 * (so the file endpoint never has to check a password itself), and after the last allowed read a
 * burn-after-reads paste only serves the people who have seen the page.
 */
export async function issueFileToken(
  config: Config,
  pasta: PastaRow,
  encKey: Bytes | null,
  now: number,
): Promise<string | undefined> {
  const needed =
    pasta.privacy === 'private' || pasta.privacy === 'secret' || pasta.burn_after_reads > 0;
  if (!needed) return undefined;
  return sealToken(config.sessionSecret, 'file', {
    id: pasta.id,
    exp: now + FILE_LINK_SECONDS,
    ...(pasta.privacy === 'private' && encKey ? { k: toB64Url(encKey) } : {}),
  });
}

export async function readFileToken(
  config: Config,
  token: string | undefined,
  id: string,
  now: number,
) {
  const payload = await openToken(config.sessionSecret, 'file', token, now);
  return payload && payload.id === id ? payload : null;
}
