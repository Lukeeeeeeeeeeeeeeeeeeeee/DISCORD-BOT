const path = require('path');
const fs = require('fs');

function loadLocale(lang) {
  try {
    const p = path.join(__dirname, '..', 'locales', `${lang}.json`);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p,'utf8'));
  } catch (e) { void e; }
  // fallback to en
  const en = path.join(__dirname, '..', 'locales', 'en.json');
  return JSON.parse(fs.readFileSync(en,'utf8'));
}

function t(key, lang='en', vars={}) {
  const locale = loadLocale(lang);
  const parts = key.split('.');
  let cur = locale;
  for (const p of parts) {
    cur = cur && cur[p];
    if (!cur) break;
  }
  let str = cur || key;
  for (const k of Object.keys(vars)) {
    str = str.replace(`{${k}}`, vars[k]);
  }
  return str;
}

module.exports = { t, loadLocale };