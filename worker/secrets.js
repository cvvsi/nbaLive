/* Writes the relay's Worker secrets as JSON for `wrangler secret bulk`, from the repo secrets and
 * the encrypted refresh token in data/yahoo-token.enc. Run from the repo root (Actions -> Yahoo
 * relay). Prints nothing: the output goes to a temp file, and Action logs are public. */
const { YAHOO_CLIENT_ID: id, YAHOO_CLIENT_SECRET: secret, RELAY_KEY: key, YAHOO_LEAGUE_ID: league } = process.env;
const fail = m => { console.error(m); process.exit(1); };
if (!id || !secret) fail('YAHOO_CLIENT_ID / YAHOO_CLIENT_SECRET repo secrets are not set.');
if (!key || key.length < 16) fail('RELAY_KEY repo secret is missing or under 16 characters.');
let refresh = process.env.YAHOO_REFRESH_TOKEN;
if (!refresh) {
  try { refresh = require('../yahoo-token.js').load(secret); }
  catch (e) { fail('Could not decrypt data/yahoo-token.enc with YAHOO_CLIENT_SECRET (secret changed? log in again: Actions -> Yahoo login).'); }
}
if (!refresh) fail('No refresh token: run Actions -> Yahoo login first.');
const out = { YAHOO_CLIENT_ID: id, YAHOO_CLIENT_SECRET: secret, YAHOO_REFRESH: refresh, RELAY_KEY: key };
if (league) out.YAHOO_LEAGUE_ID = league;
process.stdout.write(JSON.stringify(out));
