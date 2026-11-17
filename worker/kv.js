/* Before a deploy (Actions -> Yahoo relay): finds the KV namespace that holds your minutes
 * overrides ("sixthman-overrides"), creating it the first time, and adds it to wrangler.toml as the
 * OV binding for this deploy (the runner's copy only; the id isn't secret, nothing is committed). */
const { execSync } = require('child_process'), fs = require('fs');
const TITLE = 'sixthman-overrides', W = 'npx --yes wrangler@4';
// the account to use, from wrangler.toml (these commands don't read it from there on their own)
const acct = (fs.readFileSync('worker/wrangler.toml', 'utf8').match(/account_id\s*=\s*"([^"]+)"/) || [])[1];
if (acct && !process.env.CLOUDFLARE_ACCOUNT_ID) process.env.CLOUDFLARE_ACCOUNT_ID = acct;
const list = () => { const t = execSync(`${W} kv namespace list`, { encoding: 'utf8' }); return JSON.parse(t.slice(t.indexOf('['))); };
let ns = list().find(n => n.title === TITLE || n.title.endsWith(TITLE));
if (!ns) {
  console.log('Creating the KV namespace for minutes overrides...');
  execSync(`${W} kv namespace create ${TITLE}`, { stdio: 'inherit' });
  ns = list().find(n => n.title === TITLE || n.title.endsWith(TITLE));
}
if (!ns) { console.error('Could not find or create the KV namespace (does the API token have Workers KV Storage: Edit?).'); process.exit(1); }
const f = 'worker/wrangler.toml', t = fs.readFileSync(f, 'utf8');
if (!/binding\s*=\s*"OV"/.test(t)) fs.writeFileSync(f, t + `\n[[kv_namespaces]]\nbinding = "OV"\nid = "${ns.id}"\n`);
console.log('Minutes overrides: KV namespace', ns.title, 'bound as OV.');
