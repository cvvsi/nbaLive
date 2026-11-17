/* Diagnose Yahoo access with the stored token: what the token grants and which endpoints answer.
 * Prints no secrets and no league data (Action logs are public; the Yahoo agreement forbids
 * sharing league data): status codes, a league count, and on a refusal Yahoo's error text.
 * Usage (in Actions): node yahoo-check.js */
const store = require('./yahoo-token.js');
const { YAHOO_CLIENT_ID: ID, YAHOO_CLIENT_SECRET: SECRET } = process.env;
const API = 'https://fantasysports.yahooapis.com/fantasy/v2';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// A refusal's body, trimmed to one line. Only printed for non-200s, which carry no league data.
const why = async x => {
  const t = (await x.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const h = x.headers.get('www-authenticate');
  return (h ? '[www-authenticate: ' + h + '] ' : '') + (t.slice(0, 300) || '(empty body)');
};

(async () => {
  console.log('client id: ' + (ID ? ID.length + ' chars, ends ' + ID.slice(-6) : 'MISSING') +
    ' | secret: ' + (SECRET ? SECRET.length + ' chars' : 'MISSING'));
  const refresh = process.env.YAHOO_REFRESH_TOKEN || store.load(SECRET);
  console.log('refresh token: ' + (process.env.YAHOO_REFRESH_TOKEN ? 'from YAHOO_REFRESH_TOKEN' : refresh ? 'from ' + store.FILE : 'MISSING'));
  const r = await fetch('https://api.login.yahoo.com/oauth2/get_token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(ID + ':' + SECRET).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, redirect_uri: 'https://localhost:8080' }),
  });
  const j = await r.json();
  const at = j.access_token;
  // Field names only (no values): shows what kind of token Yahoo issued.
  console.log(at ? 'token: OK' : 'token: FAILED (' + (j.error_description || j.error || 'no access token') + ')',
    '| fields:', Object.keys(j).join(', '), '| scope:', j.scope || '(none)', '| expires_in:', j.expires_in);
  if (!at) return;

  // 1. Is the token good for Yahoo at all? (status only: userinfo holds the user's name/email)
  const ui = await fetch('https://api.login.yahoo.com/openid/v1/userinfo', { headers: { Authorization: 'Bearer ' + at } });
  console.log(ui.status, 'userinfo (token valid for Yahoo login APIs?)', ui.status === 200 ? '' : await why(ui));

  // 2. Control: no token at all. Expect 401. A 403 here too would mean Yahoo blocks this server, not the app.
  const nt = await fetch(API + '/game/nba?format=json');
  console.log(nt.status, 'no token /game/nba (control, expect 401)', nt.status === 200 ? '' : await why(nt));

  // 3. The real calls, with the token. A browser User-Agent as a second try rules out a bot block.
  for (const p of ['/game/nba', '/users;use_login=1/games;game_keys=nba/leagues']) {
    for (const ua of [null, UA]) {
      const x = await fetch(API + p + '?format=json',
        { headers: Object.assign({ Authorization: 'Bearer ' + at }, ua ? { 'User-Agent': ua } : {}) });
      const tag = ua ? '(browser UA)' : '';
      if (x.status === 200) {
        const n = ((await x.text()).match(/"league_key"/g) || []).length;
        console.log('200 OK', p, tag, n ? `(${n} league${n > 1 ? 's' : ''})` : '');
      } else console.log(x.status, p, tag, '->', await why(x));
    }
  }
})();
