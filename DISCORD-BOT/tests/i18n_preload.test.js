const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { preloadLocales, loadLocale, t, resetLocalesForTests } = require('../src/lib/i18n');

describe('i18n preload', () => {
  afterEach(() => {
    resetLocalesForTests();
  });

  test('preloads locale files and serves translations from cache', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'i18n-preload-'));
    await fs.writeFile(path.join(dir, 'en.json'), JSON.stringify({ greeting: { hello: 'Hello {name}' } }));
    await fs.writeFile(path.join(dir, 'es.json'), JSON.stringify({ greeting: { hello: 'Hola {name}' } }));

    await preloadLocales(dir);

    const es = loadLocale('es');
    expect(es.greeting.hello).toBe('Hola {name}');
    expect(t('greeting.hello', 'es', { name: 'Ari' })).toBe('Hola Ari');
  });

  test('falls back to english when locale is missing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'i18n-fallback-'));
    await fs.writeFile(path.join(dir, 'en.json'), JSON.stringify({ greeting: { hello: 'Hello' } }));

    await preloadLocales(dir);

    expect(t('greeting.hello', 'fr')).toBe('Hello');
  });
});
