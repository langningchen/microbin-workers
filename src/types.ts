import type { Config } from './config';

/**
 * Worker secrets. They are not part of wrangler.jsonc, and `wrangler types` can only infer them
 * from a local .dev.vars (which CI does not have), so they are declared here.
 */
export interface Secrets {
  /** Required (>= 32 characters): seals upload tokens, file tokens and admin sessions. */
  SESSION_SECRET: string;
  /** Optional: absent = feature disabled. */
  ADMIN_PASSWORD?: string;
  BASIC_AUTH_PASSWORD?: string;
  UPLOADER_PASSWORD?: string;
}

export type Bindings = Env & Secrets;

export interface Variables {
  cfg: Config;
  /** Public origin used for absolute links (QR codes). */
  origin: string;
  /** Request time in unix seconds. */
  now: number;
  /** True when the request carries a valid admin session. */
  admin: boolean;
  ip: string;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
