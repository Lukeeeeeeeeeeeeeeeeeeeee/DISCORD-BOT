const path = require('path');
const fs = require('fs');

const localeCache = new Map();
const missingLocaleCache = new Set();
localeCache.set('en', {});

let preloadPromise = null;
let preloadStarted = false;

function normalizeLocaleKey(lang) {
  return (lang || 'en').toLowerCase();
}

function parseLocaleFile(contents, localeKey) {
  try {
    return JSON.parse(contents);
  } catch (e) {
    console.error('Failed to parse locale file', { locale: localeKey, error: e });
    return null;
  }
}

async function readLocaleFileAsync(localeKey) {
  const localePath = path.join(__dirname, '..', 'locales', `${localeKey}.json`);
  try {
    const raw = await fs.promises.readFile(localePath, 'utf8');
    return parseLocaleFile(raw, localeKey);
  } catch (e) {
    return null;
  }
}

async function preloadLocales() {
  if (preloadPromise) return preloadPromise;

  const localesDir = path.join(__dirname, '..', 'locales');
  preloadPromise = (async () => {
    let files = [];
    try {
      files = await fs.promises.readdir(localesDir, { withFileTypes: true });
    } catch (e) {
      console.error('Failed to enumerate locale directory', e);
      return;
    }

    const tasks = [];
    for (const entry of files) {
      if (!entry || !entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.json')) continue;
      const key = entry.name.slice(0, -5).toLowerCase();
      tasks.push((async () => {
        const parsed = await readLocaleFileAsync(key);
        if (parsed) {
          localeCache.set(key, parsed);
          missingLocaleCache.delete(key);
        } else {
          missingLocaleCache.add(key);
        }
      })());
    }

    await Promise.all(tasks);

    if (!localeCache.has('en') || !Object.keys(localeCache.get('en') || {}).length) {
      const parsedEn = await readLocaleFileAsync('en');
      if (parsedEn) {
        localeCache.set('en', parsedEn);
      } else {
        missingLocaleCache.add('en');
      }
    }
  })().catch((e) => {
    console.error('Failed to preload locales', e);
  });

  return preloadPromise;
}

function startPreload() {
  if (preloadStarted) return;
  preloadStarted = true;
  void preloadLocales();
}

function loadLocale(lang) {
  const key = normalizeLocaleKey(lang);
  if (localeCache.has(key)) return localeCache.get(key);

  startPreload();
  if (!missingLocaleCache.has(key)) {
    missingLocaleCache.add(key);
    void readLocaleFileAsync(key).then((parsed) => {
      if (!parsed) return;
      localeCache.set(key, parsed);
      missingLocaleCache.delete(key);
    });
  }

  return localeCache.get('en') || {};
}

function resolveTranslation(locale, key) {
  const parts = key.split('.');
  let cur = locale;
  for (const p of parts) {
    cur = cur && cur[p];
    if (cur === undefined || cur === null) return null;
  }
  return cur;
}

async function initI18n() {
  await preloadLocales();
  return localeCache;
}

function t(key, lang='en', vars={}) {
  const requestedLocale = loadLocale(lang);
  const englishLocale = localeCache.get('en') || {};

  const requestedValue = resolveTranslation(requestedLocale, key);
  const fallbackValue = resolveTranslation(englishLocale, key);
  let str = requestedValue ?? fallbackValue ?? key;
  for (const k of Object.keys(vars)) {
    const token = `{${k}}`;
    str = String(str).split(token).join(String(vars[k]));
  }
  return str;
}

module.exports = { t, loadLocale, initI18n };
