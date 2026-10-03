import type { FC } from 'hono/jsx';
import { allowedExpiries, availablePrivacies, type Config } from '../config';
import type { CreateBoot } from '../shared/boot';
import {
  BURN_OPTIONS,
  MIB,
  PRIVACY_LABELS,
  SYNTAX_OPTIONS,
  type Privacy,
} from '../shared/constants';
import { KDF_CLIENT_ITERATIONS } from '../shared/crypto';
import { Layout } from './layout';

export function createBoot(cfg: Config): CreateBoot {
  return {
    kdfIterations: KDF_CLIENT_ITERATIONS,
    singlePutMax: cfg.singlePutMaxBytes,
    partBytes: cfg.partBytes,
    limits: {
      maxTextBytes: cfg.maxTextBytes,
      maxFiles: cfg.maxFiles,
      unencrypted: cfg.maxFileBytesUnencrypted,
      private: Math.min(cfg.maxFileBytesEncrypted, cfg.singlePutMaxBytes),
      secret: cfg.maxFileBytesEncrypted,
    },
    noFileUpload: cfg.noFileUpload,
    readonlyMode: cfg.readonlyMode,
  };
}

const Help: FC<{ anchor: string }> = ({ anchor }) => (
  <sup>
    {' '}
    <a href={`/guide#${anchor}`}>?</a>
  </sup>
);

const PrivacySelect: FC<{ cfg: Config; levels: Privacy[] }> = ({ cfg, levels }) => {
  const option = (level: Privacy) => (
    <option value={level} selected={level === cfg.defaultPrivacy}>
      {PRIVACY_LABELS[level]}
    </option>
  );
  const has = (level: Privacy) => levels.includes(level);
  return (
    <select id="privacy" name="privacy">
      <optgroup label="Unencrypted (no password)">
        {option('public')}
        {has('unlisted') && option('unlisted')}
      </optgroup>
      {has('readonly') && <optgroup label="Unencrypted (protected)">{option('readonly')}</optgroup>}
      {(has('private') || has('secret')) && (
        <optgroup label="Encrypted">
          {has('private') && option('private')}
          {has('secret') && option('secret')}
        </optgroup>
      )}
    </select>
  );
};

export const CreatePage: FC<{ cfg: Config }> = ({ cfg }) => {
  const levels = availablePrivacies(cfg);
  const needsPassword = levels.some((l) => l === 'readonly' || l === 'private' || l === 'secret');
  return (
    <Layout cfg={cfg} scripts={['create.js']} boot={createBoot(cfg)}>
      <form id="pasta-form" autocomplete="off" novalidate>
        <noscript>
          <p class="notice error">
            Creating uploads needs JavaScript (files are chunked and optionally encrypted in your
            browser). You can also use the <a href="/guide#api">HTTP API</a>.
          </p>
        </noscript>

        <div id="settings">
          <div>
            <label for="expiration">
              Expiration
              <Help anchor="expiration" />
            </label>
            <select id="expiration" name="expiration">
              {allowedExpiries(cfg).map((option) => (
                <option value={option.id} selected={option.id === cfg.defaultExpiry}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {cfg.enableBurnAfter && (
            <div>
              <label for="burn_after">
                Burn After
                <Help anchor="burn-after" />
              </label>
              <select id="burn_after" name="burn_after">
                {BURN_OPTIONS.map((option) => (
                  <option value={option.value} selected={option.value === cfg.defaultBurnAfter}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {cfg.highlightSyntax && (
            <div>
              <label for="syntax">
                Syntax
                <Help anchor="syntax" />
              </label>
              <select id="syntax" name="syntax">
                <option value="none">None</option>
                <option value="auto">Automatic</option>
                <optgroup label="Language">
                  {SYNTAX_OPTIONS.map((option) => (
                    <option value={option.value}>{option.label}</option>
                  ))}
                </optgroup>
              </select>
            </div>
          )}

          {levels.length > 1 && (
            <div>
              <label for="privacy">
                Privacy
                <Help anchor="privacy" />
              </label>
              <PrivacySelect cfg={cfg} levels={levels} />
            </div>
          )}

          {needsPassword && (
            <div id="password-box" hidden>
              <label for="password">
                Password
                <Help anchor="password" />
              </label>
              <input id="password" type="password" autocomplete="new-password" />
            </div>
          )}
        </div>

        <label for="content-input">Content</label>
        <textarea id="content-input" placeholder="Type something here." autofocus></textarea>

        <ul id="file-list" class="file-list" aria-live="polite"></ul>

        <div id="buttons">
          <div>
            {!cfg.noFileUpload && (
              <>
                <label for="file" id="attach-label">
                  <span id="attach-text">Select or drop file attachment</span>
                </label>
                <input type="file" id="file" multiple />
              </>
            )}
          </div>
          <div>
            {cfg.readonlyMode && (
              <input
                type="password"
                id="uploader-password"
                placeholder="Uploader password"
                autocomplete="off"
              />
            )}
          </div>
          <div>
            <button type="submit" id="submit-button" class="primary">
              Save
            </button>
          </div>
        </div>

        <progress id="progress" max="100" value="0" hidden></progress>
        <p id="form-status" role="status" class="muted"></p>
      </form>
      <p class="muted small">
        Max {Math.floor(cfg.maxFileBytesUnencrypted / MIB)} MB per file (
        {Math.floor(cfg.maxFileBytesEncrypted / MIB)} MB when encrypted), up to {cfg.maxFiles}{' '}
        files.
      </p>
    </Layout>
  );
};
