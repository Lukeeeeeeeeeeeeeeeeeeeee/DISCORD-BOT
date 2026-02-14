const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;

const localeCache = new Map();
let preloadPromise = null;
const LOCALES_DIR = path.join(__dirname, '..', 'locales');

async function preloadLocales(localesDir = LOCALES_DIR) {
  const files = await fsp.readdir(localesDir).catch(() => []);
  const loadOps = files
    .filter(name => name && name.endsWith('.json'))
    .map(async (name) => {
      const localeKey = name.replace(/\.json$/i, '');
      const localePath = path.join(localesDir, name);
      try {
        const raw = await fsp.readFile(localePath, 'utf8');
        const parsed = JSON.parse(raw);
        localeCache.set(localeKey || 'en', parsed);
      } catch (e) {
        console.error('Failed to preload locale:', localePath, e);
      }
    });

  await Promise.all(loadOps);

  if (!localeCache.has('en')) {
    const enPath = path.join(localesDir, 'en.json');
    const parsedEn = JSON.parse(await fsp.readFile(enPath, 'utf8'));
    localeCache.set('en', parsedEn);
  }
}

function ensurePreload() {
  if (!preloadPromise) {
    preloadPromise = preloadLocales().catch((e) => {
      console.error('Locale preload failed:', e);
    });
  }
  return preloadPromise;
}

function loadLocale(lang) {
  ensurePreload();
  const key = lang || 'en';
  if (localeCache.has(key)) return localeCache.get(key);
  try {
    const p = path.join(LOCALES_DIR, `${key}.json`);
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      localeCache.set(key, parsed);
      return parsed;
    }
  } catch (e) { void e; }
  const enKey = 'en';
  if (localeCache.has(enKey)) return localeCache.get(enKey);
  const en = path.join(LOCALES_DIR, 'en.json');
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

function resetLocalesForTests() {
  localeCache.clear();
  preloadPromise = null;
}

module.exports = { t, loadLocale, preloadLocales, resetLocalesForTests };
