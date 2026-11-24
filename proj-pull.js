// Daily pull of the two outside projections (Nov 2026): Elite Fantasy Basketball's category-league
// rest-of-season projections and Basketball Monster's (Josh Projections), read with your own
// logins in a headless browser and sent to your relay (POST /proj, kept in its KV storage behind
// the relay key), never committed: the repo and its logs are public and both sites are paid.
// The log shows only steps, page paths, column labels, menu labels and row counts.
// Secrets: BBM_USER / BBM_PASS, EFB_USER / EFB_PASS, RELAY_KEY. Env: SITE (both | bbm | efb),
// DRY=1 (read only, send nothing), RELAY_URL.
const { chromium } = require('playwright');

const RELAY = process.env.RELAY_URL || 'https://sixthman-yahoo.saac-choi.workers.dev';
const SITES = {
  bbm: {
    name: 'Basketball Monster',
    home: 'https://basketballmonster.com/',
    login: 'https://basketballmonster.com/login.aspx',
    proj: process.env.BBM_URL || 'https://basketballmonster.com/projections.aspx',
    user: process.env.BBM_USER, pass: process.env.BBM_PASS,
  },
  efb: {
    name: 'Elite Fantasy Basketball',
    home: 'https://elitefantasybasketball.com/',
    login: '',
    proj: process.env.EFB_URL || 'https://elitefantasybasketball.com/category-league-projections/',
    user: process.env.EFB_USER, pass: process.env.EFB_PASS,
  },
};
// The fields every snapshot carries, in this order (the EFB bookmark's, so the page reads both alike).
const F = ['rank', 'name', 'inj', 'team', 'pos', 'g', 'mpg', 'pts', 'tpm', 'reb', 'ast', 'stl', 'blk', 'fg', 'fga', 'ft', 'fta', 'to'];

const path = u => { try { const x = new URL(u); return x.host + x.pathname; } catch (e) { return '?'; } };
const log = (...a) => console.log(...a);

// The visible password field in any frame, with the frame it's in.
async function findPass(page) {
  for (const f of page.frames()) {
    const p = f.locator('input[type=password]:visible').first();
    if (await p.count().catch(() => 0)) return { f, p };
  }
  return null;
}

async function signIn(page, s) {
  if (s.login) {
    const r = await page.goto(s.login, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => null);
    log(`  login page: ${r ? r.status() : 'no answer'} ${path(page.url())}`);
  } else {
    const r = await page.goto(s.home, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => null);
    log(`  home: ${r ? r.status() : 'no answer'} ${path(page.url())}`);
  }
  await page.waitForTimeout(2500);
  let pf = await findPass(page);
  if (!pf) {
    // Find a "Log in" / "Sign in" link or button and follow it.
    const link = page.locator('a:visible, button:visible').filter({ hasText: /^\s*(log ?in|sign ?in|member login|login)\s*$/i }).first();
    if (await link.count()) {
      await link.click().catch(() => {});
      await page.waitForTimeout(4000);
      log(`  followed the login link: ${path(page.url())}`);
      pf = await findPass(page);
    }
  }
  if (!pf) {
    log('  no password field found. Inputs on the page (names/types only):');
    for (const f of page.frames()) {
      const ins = await f.$$eval('input', els => els.map(e => `${e.type}:${e.name || e.id || '-'}`)).catch(() => []);
      if (ins.length) log(`    ${path(f.url())}: ${ins.slice(0, 15).join(', ')}`);
    }
    return false;
  }
  // Pick the login form, not a sign-up form or a search box: mark each password field's form and
  // prefer one whose fields don't look like registration (reg_, register, confirm, signup).
  const { f } = pf;
  const pick = await f.evaluate(() => {
    const vis = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    const forms = [...document.querySelectorAll('input[type=password]')].filter(vis).map(p => p.form || p.closest('div,section') || document.body);
    const uniq = [...new Set(forms)];
    const info = uniq.map((fm, i) => {
      const ins = [...fm.querySelectorAll('input')].filter(vis);
      const desc = ins.map(e => `${e.type}:${e.name || e.id || '-'}`).join(', ');
      const reg = /reg|register|signup|sign_up|confirm|password2|first.?name/i.test(desc + ' ' + (fm.id || '') + ' ' + (fm.className || ''));
      const pws = ins.filter(e => e.type === 'password').length;
      return { i, desc, reg, pws };
    });
    const best = info.filter(x => !x.reg && x.pws === 1)[0] || info.filter(x => !x.reg)[0] || info[0];
    uniq.forEach((fm, i) => fm.setAttribute('data-sm-form', i === best.i ? 'login' : 'other'));
    const fm = uniq[best.i];
    // Some sites (ASP.NET) wrap the whole page in one form: the username is the text field just
    // before the password, and the button the first "Log in / Sign in" after it.
    const pw = [...fm.querySelectorAll('input[type=password]')].find(vis);
    const all = [...fm.querySelectorAll('input, button, a')].filter(vis), at = all.indexOf(pw);
    const un = all.slice(0, at).reverse().find(e => e.tagName === 'INPUT' && /^(text|email|)$/.test(e.getAttribute('type') || ''));
    const sb = all.slice(at + 1).find(e => /^\s*(log ?in|sign ?in|submit)\s*$/i.test(e.innerText || e.value || ''))
      || all.slice(at + 1).find(e => e.type === 'submit');
    if (un) un.setAttribute('data-sm-user', '1');
    if (sb) sb.setAttribute('data-sm-btn', '1');
    const btns = [...fm.querySelectorAll('button, input[type=submit], input[type=button], a')].filter(vis).map(b => (b.innerText || b.value || '').trim().slice(0, 30)).filter(Boolean);
    return { forms: info.map(x => (x.reg ? '[sign-up] ' : '') + x.desc), btns };
  }).catch(e => null);
  if (!pick) { log('  could not read the login form'); return false; }
  log(`  forms with a password: ${pick.forms.join('  ||  ')}`);
  log(`  buttons in the login form: ${pick.btns.join(', ') || 'none'}`);
  const fm = f.locator('[data-sm-form=login]');
  const u = fm.locator('[data-sm-user]').first();
  const p = fm.locator('input[type=password]:visible').first();
  if (!(await u.count())) { log('  password field found but no username field'); return false; }
  await u.fill(s.user);
  await p.fill(s.pass);
  const btn = fm.locator('[data-sm-btn]').first();
  const how = (await btn.count()) ? 'button' : 'Enter';
  await Promise.all([
    page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
    how === 'button' ? btn.click() : p.press('Enter'),
  ]);
  await page.waitForTimeout(5000);
  const still = await findPass(page);
  log(`  submitted with ${how} · now on ${path(page.url())} · password field still showing: ${!!still}`);
  if (still) {
    // The site's own message, if any (GitHub masks the username if it appears).
    const msg = await page.locator('.woocommerce-error, .mepr_error, .error, .alert, [role=alert], .validation-summary-errors, span[style*="color:Red"], .text-danger')
      .allInnerTexts().catch(() => []);
    const m = msg.map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ').slice(0, 200);
    log(`  site message: ${m || 'none'}`);
    const cap = await page.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .cf-turnstile').count().catch(() => 0);
    log(`  captcha on the page: ${cap ? 'yes' : 'no'}`);
  }
  return !still;
}

// EFB: the table with th[data-key] columns, in the page or a frame (Playwright reads any frame).
const EFBK = { rank: 'rank', player: 'name', tag: 'inj', team: 'team', pos: 'pos', gp: 'g', mpg: 'mpg', pts: 'pts', tpm: 'tpm', reb: 'reb', ast: 'ast', stl: 'stl', blk: 'blk', fgpct: 'fg', fgpct_comp: 'fga', ftpct: 'ft', ftpct_comp: 'fta', to: 'to' };
async function readEFB(page) {
  for (let i = 0; i < 40; i++) {
    for (const f of page.frames()) {
      const t = await f.evaluate(K => {
        const tb = [...document.querySelectorAll('table')].find(t => t.querySelector('th[data-key="mpg"]') && t.querySelector('th[data-key="pts"]'));
        if (!tb) return null;
        const hs = [...tb.querySelectorAll('thead th')].map(th => K[th.getAttribute('data-key')] || null);
        const rows = [...tb.querySelectorAll('tbody tr')].map(tr => {
          const c = [...tr.children].map(td => (td.textContent || '').trim()), o = {};
          hs.forEach((k, i) => { if (k) o[k] = c[i]; });
          return o;
        });
        return { hs: hs.filter(Boolean), rows };
      }, EFBK).catch(() => null);
      if (t) return t;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

// BBM: Player Rankings, switched to Josh Projections with every player showing. The page is
// ASP.NET: each menu change posts the page back, so wait for it to reload after each one.
async function selects(page) {
  return page.$$eval('select', ss => ss.map(s => ({
    id: s.id || s.name, sel: (s.options[s.selectedIndex] || {}).text || '',
    opts: [...s.options].map(o => o.text.trim()),
  }))).catch(() => []);
}
async function choose(page, id, label) {
  const loc = page.locator(`select[id="${id}"], select[name="${id}"]`).first();
  await Promise.all([
    page.waitForNavigation({ timeout: 20000 }).catch(() => {}),
    loc.selectOption({ label }),
  ]);
  await page.waitForTimeout(2500);
}
const BBMK = { 'Rank': 'rank', 'Name': 'name', 'Inj': 'inj', 'Team': 'team', 'Pos': 'pos', 'g': 'g', 'm/g': 'mpg', 'p/g': 'pts', '3/g': 'tpm', 'r/g': 'reb', 'a/g': 'ast', 's/g': 'stl', 'b/g': 'blk', 'fg%': 'fg', 'fga/g': 'fga', 'ft%': 'ft', 'fta/g': 'fta', 'to/g': 'to' };
async function readBBM(page) {
  await page.waitForTimeout(3000);
  let ss = await selects(page);
  log(`  menus: ${ss.map(s => `${s.id} = "${s.sel}" [${s.opts.slice(0, 14).join(' / ')}]`).join('  ||  ')}`);
  // 1. the projections source
  const src = ss.find(s => s.opts.some(o => /^josh projections$/i.test(o)));
  if (src && !/^josh projections$/i.test(src.sel)) { await choose(page, src.id, src.opts.find(o => /^josh projections$/i.test(o))); log('  picked Josh Projections'); }
  else if (!src) log('  no "Josh Projections" menu found');
  // 2. rest of season, when the page offers a choice
  ss = await selects(page);
  const ros = ss.find(s => s.opts.some(o => /rest of (the )?season|\bros\b/i.test(o)));
  if (ros && !/rest of (the )?season|\bros\b/i.test(ros.sel)) { await choose(page, ros.id, ros.opts.find(o => /rest of (the )?season|\bros\b/i.test(o))); log('  picked rest of season'); }
  // 3. as many players as it offers
  ss = await selects(page);
  const pf = ss.find(s => s.opts.includes('All Players'));
  if (pf && pf.sel !== 'All Players') { await choose(page, pf.id, 'All Players'); log('  picked All Players'); }
  ss = await selects(page);
  const cnt = ss.find(s => s.opts.length >= 3 && s.opts.every(o => /^(all|top )?\s*\d+$|^all( players)?$/i.test(o)));
  if (cnt) {
    const best = cnt.opts.find(o => /^all/i.test(o)) || cnt.opts.slice().sort((a, b) => +b.replace(/\D/g, '') - +a.replace(/\D/g, ''))[0];
    if (best !== cnt.sel) { await choose(page, cnt.id, best); log(`  picked ${best} players`); }
  } else log('  no player-count menu found');
  ss = await selects(page);
  log(`  menus now: ${ss.map(s => `${s.id} = "${s.sel}"`).join(', ')}`);
  return page.evaluate(K => {
    const ts = [...document.querySelectorAll('table')].map(t => ({ t, n: t.querySelectorAll('tr').length })).sort((a, b) => b.n - a.n);
    if (!ts.length) return null;
    const t = ts[0].t, trs = [...t.querySelectorAll('tr')];
    const hr = trs.find(tr => [...tr.children].some(c => c.textContent.trim() === 'Name'));
    if (!hr) return null;
    // a header cell can hold a menu (its options' text runs together): match on the cell's own text
    const lab = c => [...c.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim() || c.textContent.trim();
    const hs = [...hr.children].map(c => K[lab(c)] || K[c.textContent.trim()] || null);
    const rows = trs.filter(tr => tr !== hr && tr.children.length === hr.children.length).map(tr => {
      const c = [...tr.children].map(td => (td.textContent || '').trim()), o = {};
      hs.forEach((k, i) => { if (k) o[k] = c[i]; });
      return o;
    }).filter(o => o.name && o.name !== 'Name');
    return { hs: hs.filter(Boolean), rows };
  }, BBMK).catch(() => null);
}

async function links(page, re) {
  const out = new Set();
  for (const f of page.frames()) {
    const hs = await f.$$eval('a[href]', as => as.map(a => a.href)).catch(() => []);
    for (const h of hs) if (re.test(h)) out.add(h.split(/[?#]/)[0]);
  }
  return [...out];
}

// Rows -> the snapshot the page reads: {v, src, at, f, r}, numbers as plain strings, percentages as 0-100.
function snap(src, t) {
  const num = x => String(x == null ? '' : x).replace(/[^0-9.\-]/g, '');
  const r = t.rows.map(o => F.map(k => {
    if (['name', 'inj', 'team', 'pos'].includes(k)) return String(o[k] || '').replace(/\s+/g, ' ').trim();
    let v = num(o[k]);
    if ((k === 'fg' || k === 'ft') && v !== '' && +v <= 1) v = String(Math.round(+v * 1000) / 10);
    return v;
  })).filter(x => x[1] && +x[F.indexOf('mpg')] > 0);
  return { v: 1, src, at: new Date().toISOString(), f: F, r };
}

async function pull(key) {
  const s = SITES[key];
  log(`\n== ${s.name}`);
  if (!s.user || !s.pass) { log(`  skipped: ${key.toUpperCase()}_USER / ${key.toUpperCase()}_PASS secrets not set`); return false; }
  // GitHub's runners come with Google Chrome: use it, and fall back to Playwright's own browser
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', viewport: { width: 1400, height: 1000 } });
  let ok = false;
  try {
    const inn = await signIn(page, s);
    log(`  signed in: ${inn ? 'yes' : 'no'}`);
    if (inn) {
      const r = await page.goto(s.proj, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
      log(`  projections page: ${r ? r.status() : 'no answer'} ${path(page.url())}`);
      const t = key === 'efb' ? await readEFB(page) : await readBBM(page);
      if (!t) log('  table: not found');
      else {
        const sn = snap(key, t), miss = F.filter(k => !t.hs.includes(k));
        log(`  table: ${t.rows.length} rows, ${sn.r.length} with minutes · fields missing: ${miss.join(', ') || 'none'}`);
        // league-wide medians only (no player's numbers): projections show ~60+ games left, season stats ~15
        const med = k => { const v = sn.r.map(x => +x[F.indexOf(k)]).filter(x => x > 0).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : '-'; };
        log(`  medians: g ${med('g')} · mpg ${med('mpg')} · pts ${med('pts')} · fg% ${med('fg')}`);
        if (key === 'bbm') { const ls = await links(page, /projection/i); log(`  projection links: ${ls.map(path).join(' | ') || 'none'}`); }
        // a rest-of-season projection lists most of the season's games left; season stats so far don't
        const gl = med('g');
        if (sn.r.length < 100) log('  too few rows: not sent');
        else if (!(gl >= 25)) log(`  median games ${gl}: looks like stats so far, not a projection; not sent`);
        else if (process.env.DRY) { log('  dry run: not sent'); ok = true; }
        else {
          const res = await fetch(RELAY.replace(/\/+$/, '') + '/proj', { method: 'POST',
            headers: { 'X-Relay-Key': process.env.RELAY_KEY || '', 'Content-Type': 'application/json' }, body: JSON.stringify(sn) }).catch(e => ({ ok: false, status: e.message }));
          const o = res.json ? await res.json().catch(() => null) : null;
          log(`  sent to the relay: ${res.ok && o && !o.error ? 'yes' : 'no (' + (o && o.error || res.status) + ')'}`);
          ok = !!(res.ok && o && !o.error);
        }
      }
    }
  } catch (e) { log(`  error: ${String(e.message).split('\n')[0]}`); }
  await browser.close();
  log(`  result: ${ok ? 'OK' : 'failed'}`);
  return ok;
}

(async () => {
  const which = (process.env.SITE || 'both').toLowerCase();
  const keys = which === 'both' ? ['efb', 'bbm'] : [which];
  let all = true;
  for (const k of keys) all = (await pull(k)) && all;
  process.exit(all ? 0 : 1);
})();
