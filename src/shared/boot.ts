/** Data the server hands to page scripts through <script type="application/json" id="boot">. */
import type { ViewMode } from './constants';

export interface CreateBoot {
  /** PBKDF2 iterations for secret uploads (derived in the browser). */
  kdfIterations: number;
  singlePutMax: number;
  partBytes: number;
  limits: {
    maxTextBytes: number;
    maxFiles: number;
    unencrypted: number;
    /** private uploads: bounded by the single request limit */
    private: number;
    secret: number;
  };
  noFileUpload: boolean;
  readonlyMode: boolean;
}

export interface PasteBoot {
  id: string;
  mode: 'plain' | 'private' | 'secret';
  syntax: string;
  shortUrl: string;
  view: ViewMode;
  /** The paste text (plain mode only is rendered server side; kept for highlighting). */
  secret?: {
    salt: string;
    iter: number;
    files: { idx: number; size: number }[];
    canRemove: boolean;
  };
}
