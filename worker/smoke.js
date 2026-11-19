/* After a deploy: one real /sync through the relay, printing only counts and checks, never league
 * data (Action logs are public). Fails the job if the relay can't build the bundle. */
const u = 'https://sixthman-yahoo.saac-choi.workers.dev', key = process.env.RELAY_KEY;
(async () => {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(u + '/sync', { headers: { 'X-Relay-Key': key } }).catch(e => ({ ok: false, status: e.message }));
    const o = r.json ? await r.json().catch(() => null) : null;
    if (r.ok && o && o.v === 1) {
      const slots = {}; for (const p of o.p) slots[p[4] || '(none)'] = (slots[p[4] || '(none)'] || 0) + 1;
      console.log('sync OK:', Object.keys(o.teams).length, 'teams,', o.p.length, 'players, me', o.me ? 'found' : 'MISSING');
      console.log('slots:', JSON.stringify(slots), '| eligible positions on', o.p.filter(p => p[5]).length, 'players');
      console.log('active spots:', JSON.stringify([...new Set(Object.values(o.act))]), '| adds:', o.adds && o.adds[o.me] != null ? 'read' : 'not read', '| max weekly adds:', o.cfg && o.cfg.maxAdds);
      console.log('matchup:', o.mu ? `week ${o.mu.week}, ${o.mu.dates.length} days, ${o.mu.rows.length} teams, columns ${o.mu.lab.join(' ')}, attempts ${o.mu.rows.every(r => r.x && r.x.fga != null && r.x.fta != null) ? 'read' : 'not read'}` : 'MISSING');
      if (o.lu) {
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
        for (const t of Object.keys(o.lu)) {
          const line = Object.keys(o.lu[t]).sort().map(d => {
            const v = Object.values(o.lu[t][d]), act = v.filter(x => x[0] && !/^(BN|IL|IR|NA)/.test(x[0]));
            return d.slice(5) + ':' + act.length + 'act' + (d <= today ? '/' + act.filter(x => x[1] === 1).length + 'pl' + (act.some(x => x[1] == null) ? '?' : '') : '');
          }).join(' ');
          console.log('lineups', t === o.me ? 'me ' : 'opp', line);
        }
      } else console.log('lineups: MISSING');
      const tags = {}; for (const p of o.p) if (p[6]) tags[p[6]] = (tags[p[6]] || 0) + 1;
      console.log('Yahoo status tags league-wide:', JSON.stringify(tags), '| mine tagged:', o.p.filter(p => p[3] === o.me && p[6]).length, 'of', o.p.filter(p => p[3] === o.me).length);
      console.log('available players read:', (o.fa || []).length, '| with positions:', (o.fa || []).filter(x => x[3]).length, '| tagged:', (o.fa || []).filter(x => x[4]).length);
      console.log('schedule weeks:', Object.keys(o.sched).length, '| categories:', (o.cfg.cats || []).join(' '), '| positions:', Object.keys(o.cfg.pos || {}).join(' '));
      // the analyst (MCP): handshake, tool list, and one call each to the two main tools (sizes only)
      const call = async (id, method, params) => (await fetch(u + '/mcp/' + encodeURIComponent(key), { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json();
      const ini = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
      const tl = await call(2, 'tools/list', {});
      console.log('analyst:', ini.result ? ini.result.serverInfo.name : 'FAILED', '|', tl.result ? tl.result.tools.length + ' tools' : 'no tools');
      for (const t of ['get_my_team', 'get_matchup', 'get_free_agents']) {
        const r = await call(3, 'tools/call', { name: t, arguments: {} }), c = r.result && r.result.content[0].text;
        let info = ''; try { const j = JSON.parse(c); info = t === 'get_my_team' ? (j.roster || []).filter(p => p.proj_rank).length + ' of ' + (j.roster || []).length + ' matched to our data' : t === 'get_free_agents' ? (j.players || []).filter(p => p.proj_rank).length + ' of ' + (j.players || []).length + ' matched' : 'chance to win ' + j.chance_to_win_week + ', ' + (j.categories || []).length + ' categories'; } catch (e) { info = String(c).slice(0, 120); }
        console.log('  ' + t + ':', r.result && r.result.isError ? 'ERROR ' + String(c).slice(0, 160) : info);
      }
      // play clips (worker/nba.js): status codes only
      const pr = await (await fetch(u + '/nba/probe', { headers: { 'X-Relay-Key': key } })).json().catch(e => ({ error: e.message }));
      console.log('nba clips:', JSON.stringify(pr));
      return;
    }
    console.log('try', i + 1, '->', r.status, o && o.error ? o.error : '');
    if (r.status === 401 || (o && o.error && !/fetch|521|522|1101/.test(String(r.status)))) process.exit(1);
    await new Promise(z => setTimeout(z, 4000));
  }
  process.exit(1);
})();
