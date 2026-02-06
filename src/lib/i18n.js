const path = require('path');
const fs = require('fs');

const localeCache = new Map();

function loadLocale(lang) {
  const key = lang || 'en';
  if (localeCache.has(key)) return localeCache.get(key);
  try {
    const p = path.join(__dirname, '..', 'locales', `${key}.json`);
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      localeCache.set(key, parsed);
      return parsed;
    }
  } catch (e) { void e; }
  const enKey = 'en';
  if (localeCache.has(enKey)) return localeCache.get(enKey);
  const en = path.join(__dirname, '..', 'locales', 'en.json');
  const parsedEn = JSON.parse(fs.readFileSync(en, 'utf8'));
  localeCache.set(enKey, parsedEn);
  return parsedEn;
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
    const token = `{${k}}`;
    str = String(str).split(token).join(String(vars[k]));
  }
  return str;
}

module.exports = { t, loadLocale };