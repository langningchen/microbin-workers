import type { PastaRow } from '../db/pastas';
import { badRequest } from '../errors';
import { safeEqual } from '../lib/safe-equal';
import { fromB64Url, toB64Url } from '../shared/base64url';
import {
  KDF_SERVER_MAX_ITERATIONS,
  SALT_BYTES,
  deriveSecrets,
  randomBytes,
  verifierFor,
  type Bytes,
} from '../shared/crypto';

export interface Credentials {
  salt: string;
  iter: number;
  verifier: string;
  /** Raw AES key. Never stored; used to encrypt content right now / sealed into upload tokens. */
  encKey: Bytes;
}

type Verifiable = Pick<PastaRow, 'kdf_salt' | 'kdf_iter' | 'verifier'>;

function assertServerIterations(iterations: number): number {
  // Production workerd throws NotSupportedError above this limit, local dev does not.
  if (iterations > KDF_SERVER_MAX_ITERATIONS) {
    throw new Error(`PBKDF2 iterations ${iterations} exceed the Workers limit`);
  }
  return iterations;
}

/** Server-side modes (readonly / private): the Worker derives everything from the password. */
export async function createCredentials(
  password: string,
  iterations: number,
): Promise<Credentials> {
  const salt = randomBytes(SALT_BYTES);
  const secrets = await deriveSecrets(password, salt, assertServerIterations(iterations));
  return {
    salt: toB64Url(salt),
    iter: iterations,
    verifier: await verifierFor(secrets.authKey),
    encKey: secrets.encKey,
  };
}

/** Returns the AES key if `password` is right for this paste, otherwise `null`. */
export async function unlockWithPassword(
  pasta: Verifiable,
  password: string,
): Promise<Bytes | null> {
  if (!pasta.kdf_salt || !pasta.kdf_iter || !pasta.verifier) return null;
  const salt = fromB64Url(pasta.kdf_salt);
  if (!salt) return null;
  const secrets = await deriveSecrets(password, salt, assertServerIterations(pasta.kdf_iter));
  return (await safeEqual(await verifierFor(secrets.authKey), pasta.verifier))
    ? secrets.encKey
    : null;
}

/** Secret mode: the browser derived `authKey` itself; the server only compares its hash. */
export async function checkAuthKey(
  pasta: Verifiable,
  authKey: string | undefined | null,
): Promise<boolean> {
  if (!authKey || !pasta.verifier) return false;
  const decoded = fromB64Url(authKey);
  if (!decoded || decoded.length !== 32) return false;
  return safeEqual(await verifierFor(decoded), pasta.verifier);
}

export function decodeFixedB64(value: string, bytes: number, field: string): Bytes {
  const decoded = fromB64Url(value);
  if (!decoded || decoded.length !== bytes)
    throw badRequest(`${field} must be ${bytes} bytes (base64url)`);
  return decoded;
}
