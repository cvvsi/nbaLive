/* The Yahoo refresh token, stored encrypted in data/yahoo-token.enc so it can live in this
 * public repo. The key is derived from the YAHOO_CLIENT_SECRET repo secret, so the file is
 * useless without that secret. AES-256-GCM: base64(iv 12 | tag 16 | ciphertext).
 */
const crypto = require('crypto');
const fs = require('fs');

const FILE = 'data/yahoo-token.enc';
const key = secret => crypto.createHash('sha256').update('yahoo-refresh:' + secret).digest();

function save(token, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(secret), iv);
  const ct = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  fs.writeFileSync(FILE, Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64') + '\n');
}

function load(secret) {
  let b;
  try { b = Buffer.from(fs.readFileSync(FILE, 'utf8').trim(), 'base64'); } catch (e) { return null; }
  const d = crypto.createDecipheriv('aes-256-gcm', key(secret), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

module.exports = { save, load, FILE };
