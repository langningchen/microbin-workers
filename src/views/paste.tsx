import type { FC } from 'hono/jsx';
import type { Config } from '../config';
import type { PastaKind } from '../db/pastas';
import { formatBytes } from '../lib/bytes';
import { fileKind } from '../lib/mime';
import { formatAgo } from '../lib/time';
import type { DisplayFile } from '../services/access';
import type { PasteBoot } from '../shared/boot';
import { VIEW_MODES, type Privacy } from '../shared/constants';
import { Layout, Notice, Time } from './layout';

export interface PastaView {
  id: string;
  kind: PastaKind;
  privacy: Privacy;
  syntax: string;
  editable: boolean;
  /** The edit link is offered (editable, and not client-side encrypted). */
  canEdit: boolean;
  /** Plain text to show. Empty for secret pastas (decrypted in the browser). */
  content: string;
  createdAt: number;
  expiresAt: number | null;
  readCount: number;
  lastReadAt: number;
  burnAfterReads: number;
  files: DisplayFile[];
  /** Access token appended to file links (private / burn-after-reads pastas). */
  token?: string | undefined;
  /** For secret pastas: parameters the browser needs to derive the key. */
  secret?: { salt: string; iter: number };
}

const Help: FC<{ anchor: string }> = ({ anchor }) => (
  <sup>
    {' '}
    <a href={`/guide#${anchor}`}>?</a>
  </sup>
);

export function fileHref(view: PastaView, file: DisplayFile, preview = false): string {
  const query = new URLSearchParams();
  if (preview) query.set('preview', 'true');
  if (view.token) query.set('t', view.token);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return `/file/${view.id}/${file.idx}${suffix}`;
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const CodeBlock: FC<{ text: string; syntax: string }> = ({ text, syntax }) => (
  <div class="code-container">
    <pre>
      <code id="code" data-syntax={syntax}>
        {splitLines(text).map((line) => (
          <span class="line">{line}</span>
        ))}
      </code>
    </pre>
  </div>
);

const FileTile: FC<{ file: DisplayFile }> = ({ file }) => {
  const dot = file.name.lastIndexOf('.');
  const ext = dot > 0 ? file.name.slice(dot + 1, dot + 6).toUpperCase() : 'FILE';
  return (
    <div class="embed-media placeholder">
      <span>{ext}</span>
    </div>
  );
};

const Media: FC<{ view: PastaView; file: DisplayFile }> = ({ view, file }) => {
  const kind = fileKind(file.name);
  const src = fileHref(view, file);
  if (kind === 'image') {
    return (
      <a href={fileHref(view, file, true)} target="_blank" rel="noopener noreferrer">
        <img class="embed-media" src={src} alt={file.name} loading="lazy" />
      </a>
    );
  }
  if (kind === 'video') return <video class="embed-media" controls preload="metadata" src={src} />;
  if (kind === 'audio') return <audio class="embed-audio" controls preload="none" src={src} />;
  return <FileTile file={file} />;
};

const FileCard: FC<{ view: PastaView; file: DisplayFile; locked: boolean }> = ({
  view,
  file,
  locked,
}) => (
  <div class="file-card">
    {locked ? <FileTile file={file} /> : <Media view={view} file={file} />}
    <div class="file-meta">
      <div class="file-name">
        <small title={file.name}>{file.name}</small>
        <small class="muted">{formatBytes(file.size)}</small>
      </div>
      {!locked && (
        <a class="button small-button" href={fileHref(view, file)} download={file.name}>
          Download
        </a>
      )}
    </div>
  </div>
);

const FilesSection: FC<{ view: PastaView; defaultView: string }> = ({ view, defaultView }) => {
  const { files } = view;
  if (files.length === 0) return <></>;
  // Private files can only be previewed through a token-carrying link.
  const locked = view.privacy === 'secret' || (view.privacy === 'private' && !view.token);

  if (files.length === 1 && files[0]) {
    const file = files[0];
    return (
      <div class="single-file">
        {!locked && <Media view={view} file={file} />}
        <p class="center">
          <small>
            {file.name} [{formatBytes(file.size)}]
          </small>
          {!locked && (
            <a class="button small-button" href={fileHref(view, file)} download={file.name}>
              Download
            </a>
          )}
        </p>
      </div>
    );
  }

  return (
    <>
      <div id="gallery-view" class={`gallery-grid view-${defaultView}`}>
        {files.map((file) => (
          <FileCard view={view} file={file} locked={locked} />
        ))}
      </div>
      <div id="list-view" hidden>
        <table>
          <thead>
            <tr>
              <th>Filename</th>
              <th>Size</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr>
                <td>{file.name}</td>
                <td>{formatBytes(file.size)}</td>
                <td>
                  {locked ? (
                    <em>Locked</em>
                  ) : (
                    <a href={fileHref(view, file)} download={file.name}>
                      Download
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};

export function pasteBoot(cfg: Config, view: PastaView, mode: PasteBoot['mode']): PasteBoot {
  return {
    id: view.id,
    mode,
    syntax: view.syntax,
    shortUrl: cfg.shortUrl,
    view: cfg.defaultView,
    ...(view.secret
      ? {
          secret: {
            salt: view.secret.salt,
            iter: view.secret.iter,
            files: view.files.map((file) => ({ idx: file.idx, size: file.size })),
            canRemove: view.editable,
          },
        }
      : {}),
  };
}

export const PastaStatus: FC<{ cfg: Config; view: PastaView; now: number }> = ({
  cfg,
  view,
  now,
}) => {
  const remaining = view.burnAfterReads > 0 ? view.burnAfterReads - view.readCount : null;
  return (
    <div class="status">
      {cfg.showReadStats && (
        <p class="muted small">
          Read {view.readCount} {view.readCount === 1 ? 'time' : 'times'}, last{' '}
          {formatAgo(view.lastReadAt, now)}.{' '}
          {view.expiresAt ? (
            <>
              Expires <Time ts={view.expiresAt} />.
            </>
          ) : (
            'Never expires.'
          )}
        </p>
      )}
      {remaining !== null && remaining <= 0 && (
        <p class="notice error">
          This was the last allowed read: the upload is deleted. Its files stay available from this
          page for a while.
        </p>
      )}
      {remaining !== null && remaining > 0 && (
        <p class="notice">
          Burn after reads: {remaining} {remaining === 1 ? 'read' : 'reads'} left.
        </p>
      )}
    </div>
  );
};

export const PastePage: FC<{
  cfg: Config;
  view: PastaView;
  mode: PasteBoot['mode'];
  now: number;
}> = ({ cfg, view, mode, now }) => {
  const secret = mode === 'secret';
  const hasText = view.content !== '';
  return (
    <Layout cfg={cfg} title={view.id} scripts={['paste.js']} boot={pasteBoot(cfg, view, mode)}>
      <div class="toolbar">
        <div class="actions">
          {hasText && (
            <button id="copy-text-button" class="small-button" type="button">
              Copy Text
            </button>
          )}
          {secret && (
            <button id="copy-text-button" class="small-button" type="button" hidden>
              Copy Text
            </button>
          )}
          {view.kind === 'url' && (
            <button id="copy-redirect-button" class="small-button" type="button">
              Copy Redirect
            </button>
          )}
          {hasText && <a href={`/raw/${view.id}`}>Raw Text Content</a>}
          {cfg.qr && <a href={`/qr/${view.id}`}>QR</a>}
          {view.canEdit && <a href={`/edit/${view.id}`}>Edit</a>}
          {view.editable && <a href={`/remove/${view.id}`}>Remove</a>}
        </div>
        <div class="actions">
          <a href={`/upload/${view.id}`}>
            <i>{view.id}</i>
          </a>
          <button id="copy-url-button" class="small-button" type="button">
            Copy URL
          </button>
          {view.files.length > 1 && (
            <select id="view-selector" class="small-button" aria-label="File view">
              {VIEW_MODES.map((mode) => (
                <option value={mode} selected={mode === cfg.defaultView}>
                  {mode[0]?.toUpperCase()}
                  {mode.slice(1)}
                </option>
              ))}
            </select>
          )}
          {view.files.length > 1 && !secret && view.privacy !== 'private' && (
            <a class="button small-button" href={`/archive/${view.id}`}>
              Download all as ZIP
            </a>
          )}
          {view.files.length > 1 && view.privacy === 'private' && view.token && (
            <a class="button small-button" href={`/archive/${view.id}?t=${view.token}`}>
              Download all as ZIP
            </a>
          )}
          {secret && view.files.length > 0 && (
            <button id="download-all-button" class="small-button" type="button" hidden>
              Download all (decrypted ZIP)
            </button>
          )}
        </div>
      </div>

      {secret ? (
        <>
          <div id="decryption" class="panel">
            <form id="unlock-form">
              <label for="password-field">
                Please enter your key to decrypt this upload.
                <Help anchor="encryption" />
              </label>
              <input
                id="password-field"
                type="password"
                autocomplete="off"
                placeholder="Key"
                required
              />
              <button type="submit" id="unlock-button">
                Decrypt
              </button>
              <p id="unlock-status" class="notice error" role="alert" hidden></p>
            </form>
          </div>
          <div id="secret-view" hidden>
            <div id="secret-text" class="code-container" hidden>
              <pre>
                <code id="code" data-syntax={view.syntax}></code>
              </pre>
            </div>
            <div id="secret-files"></div>
          </div>
        </>
      ) : (
        <>
          {view.kind === 'url' && hasText && (
            <p>
              <a href={`/url/${view.id}`} rel="noopener noreferrer nofollow">
                → Follow this short link
              </a>
            </p>
          )}
          {hasText && <CodeBlock text={view.content} syntax={view.syntax} />}
          <FilesSection view={view} defaultView={cfg.defaultView} />
        </>
      )}
      <PastaStatus cfg={cfg} view={view} now={now} />
    </Layout>
  );
};

/** Password form used before any protected action (view, raw, download, edit, remove). */
export const UnlockPage: FC<{
  cfg: Config;
  action: string;
  heading?: string;
  error?: string | undefined;
  hidden?: Record<string, string>;
  submit?: string;
}> = ({ cfg, action, heading, error, hidden = {}, submit = 'Okay' }) => (
  <Layout cfg={cfg} title="Password">
    <form id="auth-form" class="panel" method="post" action={action}>
      <label for="password-field">
        {heading ?? 'Please enter the password to access or modify this upload.'}
        <Help anchor="password" />
      </label>
      {Object.entries(hidden).map(([name, value]) => (
        <input type="hidden" name={name} value={value} />
      ))}
      <input
        id="password-field"
        name="password"
        type="password"
        placeholder="Password"
        autocomplete="off"
        autofocus
        required
      />
      <button type="submit">{submit}</button>
      <Notice message={error} />
    </form>
  </Layout>
);

/** Shown before a burn-after-reads upload is revealed, so link previews cannot consume it. */
export const ConfirmPage: FC<{
  cfg: Config;
  id: string;
  remaining: number;
  /** The creator just published it: show the share link instead of a warning. */
  fresh: boolean;
}> = ({ cfg, id, remaining, fresh }) => (
  <Layout
    cfg={cfg}
    title="Burn after reading"
    scripts={['paste.js']}
    boot={{ id, mode: 'plain', syntax: 'none', shortUrl: cfg.shortUrl, view: cfg.defaultView }}
  >
    <div class="panel">
      {fresh && (
        <p class="notice ok">
          Upload created. Share this link: <code id="share-link">/upload/{id}</code>{' '}
          <button id="copy-url-button" class="small-button" type="button">
            Copy URL
          </button>
        </p>
      )}
      <h3>This upload burns after reading</h3>
      <p>
        It will be deleted after {remaining} more {remaining === 1 ? 'read' : 'reads'}. Revealing it
        counts as a read, so do it only when you are ready.
      </p>
      <form method="post" action={`/upload/${id}`}>
        <input type="hidden" name="confirm" value="1" />
        <button type="submit">
          {fresh ? 'Open it now (counts as a read)' : 'Reveal the upload'}
        </button>
      </form>
    </div>
  </Layout>
);
