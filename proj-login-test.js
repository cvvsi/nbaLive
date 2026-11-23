// Sign-in test for the automatic BBM / EFB projections pull (Nov 2026).
// Opens each site in a real browser (Playwright), signs in with the repo secrets, opens the
// projections page and counts the table's rows. It saves nothing and prints only what is safe in
// a public log: steps, status codes, page paths (no query strings), page titles, column labels
// and row counts. Never a cell value. Secrets: BBM_USER / BBM_PASS, EFB_USER / EFB_PASS.
// Optional: BBM_URL / EFB_URL (projections page), SITE (both | bbm | efb).
const { chromium } = require('playwright');

const SITES = {
  bbm: {
    name: 'Basketball Monster',
    home: 'https://basketballmonster.com/',
    login: 'https://basketballmonster.com/login.aspx',
    proj: process.env.BBM_URL || 'https://basketballmonster.com/playerrankings.aspx',
    user: process.env.BBM_USER, pass: process.env.BBM_PASS,
  },
  efb: {
    name: 'Elite Fantasy Basketball',
    home: 'https://elitefantasybasketball.com/',
    login: '',
    proj: process.env.EFB_URL || '',
    user: process.env.EFB_USER, pass: process.env.EFB_PASS,
  },
};

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
    const btns = [...fm.querySelectorAll('button, input[type=submit], input[type=button], a')].filter(vis).map(b => (b.innerText || b.value || '').trim().slice(0, 30)).filter(Boolean);
    return { forms: info.map(x => (x.reg ? '[sign-up] ' : '') + x.desc), btns };
  }).catch(e => null);
  if (!pick) { log('  could not read the login form'); return false; }
  log(`  forms with a password: ${pick.forms.join('  ||  ')}`);
  log(`  buttons in the login form: ${pick.btns.join(', ') || 'none'}`);
  const fm = f.locator('[data-sm-form=login]');
  const u = fm.locator('input[type=email]:visible, input[type=text]:visible, input:not([type]):visible').first();
  const p = fm.locator('input[type=password]:visible').first();
  if (!(await u.count())) { log('  password field found but no username field'); return false; }
  await u.fill(s.user);
  await p.fill(s.pass);
  const btn = fm.locator('button[type=submit]:visible, input[type=submit]:visible, button:visible, input[type=button]:visible')
    .filter({ hasNotText: /register|sign ?up|forgot/i }).first();
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

// EFB: its table carries th[data-key]; it may sit in a frame from another address (fine here).
async function readEFB(page) {
  for (let i = 0; i < 30; i++) {
    for (const f of page.frames()) {
      const n = await f.evaluate(() => {
        const t = [...document.querySelectorAll('table')].find(t => t.querySelector('th[data-key="mpg"]') && t.querySelector('th[data-key="pts"]'));
        if (!t) return null;
        return { rows: t.querySelectorAll('tbody tr').length, keys: [...t.querySelectorAll('thead th')].map(th => th.getAttribute('data-key') || '').filter(Boolean) };
      }).catch(() => null);
      if (n) return { ...n, frame: path(f.url()) };
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

// BBM: the biggest table on the page, with its header labels.
async function readBBM(page) {
  await page.waitForTimeout(4000);
  return page.evaluate(() => {
    const ts = [...document.querySelectorAll('table')].map(t => ({ t, n: t.querySelectorAll('tr').length })).sort((a, b) => b.n - a.n);
    if (!ts.length) return null;
    const t = ts[0].t, hr = t.querySelector('thead tr') || t.querySelector('tr');
    return { rows: ts[0].n - 1, keys: [...hr.children].map(c => c.textContent.trim()).filter(Boolean).slice(0, 40) };
  }).catch(() => null);
}

async function links(page, re) {
  const out = new Set();
  for (const f of page.frames()) {
    const hs = await f.$$eval('a[href]', as => as.map(a => a.href)).catch(() => []);
    for (const h of hs) if (re.test(h)) out.add(h.split(/[?#]/)[0]);
  }
  return [...out];
}

async function test(key) {
  const s = SITES[key];
  log(`\n== ${s.name}`);
  if (!s.user || !s.pass) { log(`  skipped: ${key.toUpperCase()}_USER / ${key.toUpperCase()}_PASS secrets not set`); return false; }
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', viewport: { width: 1400, height: 1000 } });
  let ok = false;
  try {
    const inn = await signIn(page, s);
    log(`  signed in: ${inn ? 'yes' : 'no'}`);
    if (inn) {
      let target = s.proj;
      if (!target) {
        const ls = await links(page, /projection/i);
        log(`  projection links seen: ${ls.map(path).join(' | ') || 'none'}`);
        target = ls.find(l => /categor/i.test(l)) || ls[0];
      }
      if (target) {
        const r = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
        log(`  projections page: ${r ? r.status() : 'no answer'} ${path(page.url())} · "${(await page.title()).slice(0, 80)}"`);
        const t = key === 'efb' ? await readEFB(page) : await readBBM(page);
        if (t) {
          log(`  table: ${t.rows} rows${t.frame ? ' (in ' + t.frame + ')' : ''}`);
          log(`  columns: ${t.keys.join(', ')}`);
          ok = t.rows >= 50;
        } else log('  table: not found');
        if (key === 'efb' && !t) {
          const ls = await links(page, /projection/i);
          log(`  projection links on this page: ${ls.map(path).join(' | ') || 'none'}`);
        }
      } else log('  no projections page to open (set EFB_URL)');
    }
  } catch (e) { log(`  error: ${String(e.message).split('\n')[0]}`); }
  await browser.close();
  log(`  result: ${ok ? 'OK' : 'not yet'}`);
  return ok;
}

(async () => {
  const which = (process.env.SITE || 'both').toLowerCase();
  const keys = which === 'both' ? ['bbm', 'efb'] : [which];
  let all = true;
  for (const k of keys) all = (await test(k)) && all;
  process.exit(all ? 0 : 1);
})();
