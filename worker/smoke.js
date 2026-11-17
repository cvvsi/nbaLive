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
      console.log('schedule weeks:', Object.keys(o.sched).length, '| categories:', (o.cfg.cats || []).join(' '), '| positions:', Object.keys(o.cfg.pos || {}).join(' '));
      return;
    }
    console.log('try', i + 1, '->', r.status, o && o.error ? o.error : '');
    if (r.status === 401 || (o && o.error && !/fetch|521|522|1101/.test(String(r.status)))) process.exit(1);
    await new Promise(z => setTimeout(z, 4000));
  }
  process.exit(1);
})();
