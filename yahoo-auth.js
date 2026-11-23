/* One-time Yahoo login, to get the refresh token the nightly Action uses.
 *
 * Easiest: the "Yahoo login" workflow (Actions tab). Open the URL below, click Agree, copy the
 * code from the address bar of the localhost error page, and run the workflow with it. It trades
 * the code for a refresh token and commits it encrypted as data/yahoo-token.enc.
 *
 * Locally instead:
 *   1. node yahoo-auth.js <client_id>                          prints the login URL
 *   2. node yahoo-auth.js <client_id> <client_secret> <code>   prints the refresh token,
 *      to add as the repo secret YAHOO_REFRESH_TOKEN.
 * The code expires in a few minutes, so do step 2 right after step 1.
 *
 * In the workflow it reads YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET and YAHOO_AUTH_CODE from the
 * environment and never prints the token.
 */
// Must match the Redirect URI on the Yahoo app exactly. Yahoo no longer accepts 'oob'.
const REDIRECT = process.env.YAHOO_REDIRECT_URI || 'https://localhost:8080';
const CI = !!process.env.YAHOO_AUTH_CODE;
const [id, secret, code] = CI
  ? [process.env.YAHOO_CLIENT_ID, process.env.YAHOO_CLIENT_SECRET, process.env.YAHOO_AUTH_CODE.trim()]
  : process.argv.slice(2);

if (!id) {
  console.log(CI ? 'YAHOO_CLIENT_ID secret is not set.' : 'Usage: node yahoo-auth.js <client_id> [<client_secret> <code>]');
  process.exit(1);
}
if (!code) {
  const u = new URL('https://api.login.yahoo.com/oauth2/request_auth');
  u.search = new URLSearchParams({ client_id: id, redirect_uri: REDIRECT, response_type: 'code', scope: 'fspt-r', language: 'en-us' });
  console.log('Open this, sign in, click Agree. The browser lands on an error page at localhost;\n' +
    'copy the code from the address bar (after code=, before any &):\n\n' + u + '\n');
  console.log('Then run:  node yahoo-auth.js ' + id + ' <client_secret> <code>');
  process.exit(0);
}
if (!secret) { console.log('YAHOO_CLIENT_SECRET is not set.'); process.exit(1); }

fetch('https://api.login.yahoo.com/oauth2/get_token', {
  method: 'POST',
  headers: { Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'),
    'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT }),
}).then(r => r.json()).then(j => {
  if (!j.refresh_token) { console.error('Failed:', j.error_description || j.error || 'no refresh token returned'); process.exit(1); }
  if (CI) {
    require('./yahoo-token.js').save(j.refresh_token, secret);
    console.log('Connected. Refresh token saved encrypted to data/yahoo-token.enc.');
    return;
  }
  console.log('\nYAHOO_REFRESH_TOKEN =\n\n' + j.refresh_token + '\n');
  console.log('Add it at GitHub: repo Settings > Secrets and variables > Actions > New repository secret.');
});
