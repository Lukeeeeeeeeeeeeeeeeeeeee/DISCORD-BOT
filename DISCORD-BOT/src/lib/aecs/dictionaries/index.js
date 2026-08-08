function safeLoad(name) {
  try {
    return require(`./${name}.js`);
  } catch (err) {
    // Only log if the error is actually module not found for the TARGET file, 
    // vs an internal error in the loaded file itself.
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(`./${name}.js`)) {
      console.warn(`[AECS] Dictionary '${name}' not found; using empty fallback.`);
    } else {
      console.error(`[AECS] Fatal error loading dictionary '${name}':`, err);
    }
    return {};
  }
}

const loaders = {
  SYS: () => safeLoad('sys'),
  DB: () => safeLoad('db'),
  CMD: () => safeLoad('cmd'),
  SCH: () => safeLoad('sch'),
  API: () => safeLoad('cmd'),
  RECRUIT: () => safeLoad('recruit'),
  DM: () => safeLoad('dm'),
  ECONOMY: () => safeLoad('economy'),
  ANALYTICS: () => safeLoad('analytics')
};

const domainCache = new Map();
const mergedCache = new Map();

function normalizeCode(code) {
  if (!code) return '';
  return String(code).trim().toUpperCase();
}

function getDomainForCode(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return 'SYS';
  const dashIndex = normalized.indexOf('-');
  if (dashIndex <= 0) return 'SYS';
  return normalized.slice(0, dashIndex);
}

function loadDomain(domain) {
  const key = String(domain || 'SYS').toUpperCase();
  if (!domainCache.has(key)) {
    const loader = loaders[key] || loaders.SYS;
    const data = loader ? loader() : {};
    domainCache.set(key, data || {});
  }
  return domainCache.get(key);
}

function getDefinition(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  if (mergedCache.has(normalized)) return mergedCache.get(normalized);
  const domain = getDomainForCode(normalized);
  const dictionary = loadDomain(domain);
  const definition = dictionary && dictionary[normalized] ? dictionary[normalized] : null;
  if (definition) {
    mergedCache.set(normalized, definition);
    return definition;
  }
  if (domain !== 'SYS') {
    const sysDictionary = loadDomain('SYS');
    const fallback = sysDictionary && sysDictionary[normalized] ? sysDictionary[normalized] : null;
    if (fallback) {
      mergedCache.set(normalized, fallback);
      return fallback;
    }
  }
  return null;
}

function hasCode(code) {
  return Boolean(getDefinition(code));
}

function getAllDefinitions() {
  const result = {};
  Object.keys(loaders).forEach((domain) => {
    const dictionary = loadDomain(domain);
    Object.assign(result, dictionary);
  });
  return result;
}

function resetCacheForTests() {
  domainCache.clear();
  mergedCache.clear();
}

module.exports = {
  getDefinition,
  hasCode,
  getAllDefinitions,
  getDomainForCode,
  normalizeCode,
  resetCacheForTests
};
