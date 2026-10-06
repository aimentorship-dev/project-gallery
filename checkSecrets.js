/**
 * Fails the build if anything about to ship (dist/) contains a credential.
 *
 * dist/ is committed to a public repo, and getData.js saves whatever the network
 * returns - on 2026-10-06 four Google error pages saved as .pdf carried the Drive
 * API key, and Google's abuse scanner found them on GitHub. Runs after webpack in
 * `build` / `prod-build`; a non-zero exit stops Vercel from deploying and stops a
 * local build from producing something that must not be committed.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'dist');
const PATTERNS = [
  [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/pat[A-Za-z0-9]{14}\.[a-f0-9]{64}/, 'Airtable personal access token'],
  [/key[A-Za-z0-9]{14}\b/, 'Airtable legacy API key'],
  [/-----BEGIN (RSA |EC )?PRIVATE KEY-----/, 'private key'],
];
const SKIP_EXT = new Set(['.webp', '.avif', '.png', '.jpg', '.jpeg', '.gif', '.woff', '.woff2', '.ttf', '.otf', '.ico']);

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (!SKIP_EXT.has(path.extname(name).toLowerCase())) out.push(p);
  }
  return out;
}

if (!fs.existsSync(DIST)) {
  console.log('checkSecrets: no dist/ to scan');
  process.exit(0);
}
const hits = [];
for (const file of walk(DIST, [])) {
  const text = fs.readFileSync(file, 'latin1');
  for (const [re, label] of PATTERNS) {
    if (re.test(text)) hits.push(path.relative(__dirname, file) + '  (' + label + ')');
  }
}
if (hits.length) {
  console.error('checkSecrets: credential found in build output - refusing to continue:');
  hits.forEach(h => console.error('   ' + h));
  process.exit(1);
}
console.log('checkSecrets: dist/ clean');
