/* Diagnose Yahoo access with the stored token: what the token grants and which endpoints answer.
 * Prints no secrets. Usage (in Actions): node yahoo-check.js */
const store = require('./yahoo-token.js');
const { YAHOO_CLIENT_ID: ID, YAHOO_CLIENT_SECRET: SECRET } = process.env;
(async () => {
  const refresh = process.env.YAHOO_REFRESH_TOKEN || store.load(SECRET);
  const r = await fetch('https://api.login.yahoo.com/oauth2/get_token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(ID + ':' + SECRET).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, redirect_uri: 'https://localhost:8080' }),
  });
  const j = await r.json();
  console.log(j.access_token ? 'token: OK' : 'token: FAILED (' + (j.error || 'no access token') + ')', '| scope:', j.scope || '(none)');
  for (const p of ['/game/nba', '/users;use_login=1', '/users;use_login=1/games', '/users;use_login=1/games;game_keys=nba/leagues']) {
    const x = await fetch('https://fantasysports.yahooapis.com/fantasy/v2' + p + '?format=json', { headers: { Authorization: 'Bearer ' + j.access_token } });
    // status only, plus a league count: Action logs are public and league data can't be shared
    const t = await x.text(), n = (t.match(/"league_key"/g) || []).length;
    console.log(x.status, x.status === 200 ? 'OK' : x.status === 403 ? 'FORBIDDEN (access not on yet, or the app lacks Fantasy Sports)' : '', p, n ? `(${n} league${n > 1 ? 's' : ''})` : '');
  }
})();
