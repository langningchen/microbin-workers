import { allowedExpiries, type Config } from '../config';
import { EXPIRY_OPTIONS, type ExpiryId } from '../shared/constants';

/** Absolute expiry (unix seconds) for an option, or `null` for "never". */
export function expiryTimestamp(id: ExpiryId, now: number): number | null {
  const option = EXPIRY_OPTIONS.find((candidate) => candidate.id === id);
  if (!option) throw new Error(`unknown expiry ${id}`);
  return option.seconds === null ? null : now + option.seconds;
}

export function isExpiryAllowed(config: Config, id: string): id is ExpiryId {
  return allowedExpiries(config).some((option) => option.id === id);
}
