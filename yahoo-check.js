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
  console.log('token response keys:', Object.keys(j).join(', '), '| scope:', j.scope || '(none)', '| token_type:', j.token_type);
  for (const p of ['/game/nba', '/users;use_login=1', '/users;use_login=1/games', '/users;use_login=1/games;game_keys=nba/leagues']) {
    const x = await fetch('https://fantasysports.yahooapis.com/fantasy/v2' + p + '?format=json', { headers: { Authorization: 'Bearer ' + j.access_token } });
    console.log(x.status, p, (await x.text()).replace(/\s+/g, ' ').slice(0, 300));
  }
})();
