/* One-time Yahoo login, to get the refresh token the nightly Action uses.
 *
 *   1. node yahoo-auth.js <client_id>
 *        prints a Yahoo URL. Open it, sign in and click Agree. The browser then goes to
 *        https://localhost:8080/?code=XXXX and shows an error page; that's expected.
 *        Copy the code from the address bar (everything after code=, before any &).
 *   2. node yahoo-auth.js <client_id> <client_secret> <code>
 *        prints the refresh token. Add it as the repo secret YAHOO_REFRESH_TOKEN.
 *
 * The code expires in a few minutes, so do step 2 right after step 1.
 * Nothing is saved to disk; keep the token out of the repo.
 */
const [id, secret, code] = process.argv.slice(2);
// Must match the Redirect URI on the Yahoo app exactly. Yahoo no longer accepts 'oob'.
const REDIRECT = process.env.YAHOO_REDIRECT_URI || 'https://localhost:8080';

if (!id) {
  console.log('Usage: node yahoo-auth.js <client_id> [<client_secret> <code>]');
  process.exit(1);
}
if (!code) {
  const u = new URL('https://api.login.yahoo.com/oauth2/request_auth');
  u.search = new URLSearchParams({ client_id: id, redirect_uri: REDIRECT, response_type: 'code', language: 'en-us' });
  console.log('Open this, sign in, click Agree. The browser lands on an error page at localhost;\n' +
    'copy the code from the address bar (after code=, before any &):\n\n' + u + '\n');
  console.log('Then run:  node yahoo-auth.js ' + id + ' <client_secret> <code>');
  process.exit(0);
}

fetch('https://api.login.yahoo.com/oauth2/get_token', {
  method: 'POST',
  headers: { Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'),
    'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT }),
}).then(r => r.json()).then(j => {
  if (!j.refresh_token) { console.error('Failed:', j.error_description || j.error || JSON.stringify(j)); process.exit(1); }
  console.log('\nYAHOO_REFRESH_TOKEN =\n\n' + j.refresh_token + '\n');
  console.log('Add it at GitHub: repo Settings > Secrets and variables > Actions > New repository secret.');
});
