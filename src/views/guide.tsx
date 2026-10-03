import type { FC } from 'hono/jsx';
import { availablePrivacies, type Config } from '../config';
import { Layout } from './layout';

export const GuidePage: FC<{ cfg: Config }> = ({ cfg }) => {
  const levels = availablePrivacies(cfg);
  return (
    <Layout cfg={cfg} title="Guide">
      <h2 id="options">Options</h2>

      <h3 id="expiration">Expiration</h3>
      <p>
        Use the expiration dropdown to choose how long your upload should exist. When the time is up
        it is removed from the server.
      </p>

      {cfg.enableBurnAfter && (
        <>
          <h3 id="burn-after">Burn After</h3>
          <p>
            Limits how many times an upload can be read before it is deleted. Viewing a
            burn-after-reads upload first asks for confirmation, so link previews by chat apps
            cannot use up a read. After the last read the files stay downloadable from the page you
            are looking at for about an hour.
          </p>
        </>
      )}

      {cfg.highlightSyntax && (
        <>
          <h3 id="syntax">Syntax Highlighting</h3>
          <p>
            Pick a language, or "Automatic" to let your browser detect it. Highlighting runs in your
            browser; the server only stores the language you chose.
          </p>
        </>
      )}

      <h3 id="password">Password</h3>
      <p>
        Read-only, private and secret uploads need a password. For <b>read-only</b> uploads it is
        required to edit or remove them, for <b>private</b> and <b>secret</b> uploads also to read
        them.
      </p>

      <h3 id="privacy">Privacy</h3>
      <p>
        Choose how much protection your upload needs. Use lower levels on your own instance and
        higher levels on a public one. Identifiers are random, so unlisted uploads cannot be found
        unless someone has the link - but anyone with the link can see them.
      </p>
      <h4>Level 1: Public</h4>
      <p>Everyone can find, see{cfg.editable && ', modify and remove'} your upload.</p>
      {levels.includes('unlisted') && (
        <>
          <h4>Level 2: Unlisted (recommended)</h4>
          <p>
            Not shown in the list. Whoever knows its random link can see
            {cfg.editable && ', modify and remove'} it.
          </p>
        </>
      )}
      {levels.includes('readonly') && (
        <>
          <h4>Level 3: Read-only</h4>
          <p>
            Unlisted, and everyone with the link can read it, but modifying or removing it needs the
            password.
          </p>
        </>
      )}
      {levels.includes('private') && (
        <>
          <h4>Level 4: Private</h4>
          <p>
            Text and files are encrypted on the server with AES-256-GCM, using a key derived from
            your password (PBKDF2-SHA256, random salt). The password is sent to the server over
            HTTPS when you create and when you open the upload, but it is never stored.
          </p>
        </>
      )}
      {levels.includes('secret') && (
        <>
          <h4 id="encryption">Level 5: Secret</h4>
          <p>
            Your browser encrypts everything (AES-256-GCM, key from PBKDF2-SHA256 with{' '}
            {(600_000).toLocaleString('en-US')} iterations, file names included) before it is sent.
            The server never sees your password or the plain content and can only check a hash that
            proves you know the password. Forget the password and the data is gone for good.
          </p>
        </>
      )}

      <h2 id="api">HTTP API</h2>
      <p>Everything the web UI does is available over HTTP. Examples with curl:</p>
      <pre>
        <code>
          {`# Create a text upload (uses the same field names as upstream MicroBin)
curl -L -F 'content=Hello from curl' -F 'expiration=1hour' ${cfg.publicUrl || 'https://your-host'}/upload

# Upload a file (up to ~25 MB this way; the web UI handles big files in chunks)
curl -L -F 'file=@photo.jpg' -F 'expiration=1week' -F 'privacy=unlisted' ${cfg.publicUrl || 'https://your-host'}/upload

# Read it back
curl ${cfg.publicUrl || 'https://your-host'}/raw/<id>`}
        </code>
      </pre>
      <p>
        Add <code>-H 'Accept: application/json'</code> to get <code>{'{"id":…,"url":…}'}</code>{' '}
        instead of a redirect. If the instance is protected with HTTP Basic Auth add{' '}
        <code>-u user:password</code>. For files above 25 MB use the JSON API (
        <code>POST /api/pastas</code>, then <code>PUT /api/pastas/&lt;id&gt;/files/&lt;n&gt;</code>
        with the returned <code>X-Upload-Token</code>, then{' '}
        <code>POST /api/pastas/&lt;id&gt;/complete</code>).
      </p>
    </Layout>
  );
};
