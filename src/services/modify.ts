import type { PastaRow } from '../db/pastas';
import { forbidden, unauthorized } from '../errors';
import type { Bytes } from '../shared/crypto';
import { checkAuthKey, unlockWithPassword } from './credentials';

export interface Proof {
  /** Plain password (public form fields). */
  password?: string | undefined;
  /** Secret mode: authKey derived in the browser (X-Auth-Key header). */
  authKey?: string | undefined;
  /** Admin session or admin password. */
  admin?: boolean;
}

/** Edit and remove links are hidden when this is false. */
export const canEditText = (pasta: PastaRow): boolean =>
  pasta.editable === 1 && pasta.privacy !== 'secret';

export interface ModifyGrant {
  /** AES key for private pastas, needed to re-encrypt edited content. */
  encKey: Bytes | null;
}

async function passwordProof(pasta: PastaRow, proof: Proof): Promise<Bytes> {
  if (!proof.password) throw unauthorized('Password required', 'password_required');
  const key = await unlockWithPassword(pasta, proof.password);
  if (!key) throw unauthorized('Incorrect password', 'incorrect_password');
  return key;
}

export async function authorizeEdit(pasta: PastaRow, proof: Proof): Promise<ModifyGrant> {
  if (!canEditText(pasta)) throw forbidden('This upload cannot be edited', 'not_editable');
  if (pasta.privacy === 'readonly' || pasta.privacy === 'private') {
    const key = await passwordProof(pasta, proof);
    return { encKey: pasta.privacy === 'private' ? key : null };
  }
  return { encKey: null };
}

/**
 * Who may delete what:
 *  - an administrator may delete anything,
 *  - uploads created with EDITABLE=false can only be removed by an administrator,
 *  - public / unlisted uploads can be removed by anyone who has the link,
 *  - read-only / private uploads need their password, secret ones their (browser-derived) key.
 */
export async function authorizeRemove(pasta: PastaRow, proof: Proof): Promise<void> {
  if (proof.admin) return;
  if (pasta.editable !== 1) {
    throw forbidden('This upload can only be removed by an administrator', 'not_editable');
  }
  if (pasta.privacy === 'readonly' || pasta.privacy === 'private') {
    await passwordProof(pasta, proof);
  } else if (pasta.privacy === 'secret') {
    if (!(await checkAuthKey(pasta, proof.authKey))) {
      throw unauthorized('Incorrect password', 'incorrect_password');
    }
  }
}

/** Does removing this upload require a password from the person asking? */
export const removeNeedsPassword = (pasta: PastaRow): boolean =>
  pasta.privacy === 'readonly' || pasta.privacy === 'private' || pasta.privacy === 'secret';
