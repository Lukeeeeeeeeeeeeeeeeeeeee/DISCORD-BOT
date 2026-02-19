const fs = require('fs');
const os = require('os');
const path = require('path');
const { Collection } = require('discord.js');
const { loadCommandsIntoCollection } = require('../src/lib/command-loader');

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

describe('command loader', () => {
  let tempRoot = null;
  let commandsPath = null;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'command-loader-'));
    commandsPath = path.join(tempRoot, 'commands');
    fs.mkdirSync(commandsPath, { recursive: true });
  });

  afterEach(() => {
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('loads canonical command and skips compatibility proxy shims', () => {
    writeFile(
      tempRoot,
      'commands/recruiting/recruiter.js',
      `module.exports = { data: { name: 'recruiter' }, execute: async () => {} };`
    );
    writeFile(
      tempRoot,
      'commands/recruiter.js',
      `module.exports = require('./recruiting/recruiter');`
    );

    const commands = new Collection();
    const result = loadCommandsIntoCollection({ commandsPath, collection: commands });

    expect(result.loadErrors).toHaveLength(0);
    expect(commands.size).toBe(1);
    expect(commands.has('recruiter')).toBe(true);
    expect(result.commandSourceByName.get('recruiter')).toBe('recruiting/recruiter.js');
    expect(result.skippedProxyModules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: 'recruiter.js', target: 'recruiting/recruiter.js' })
      ])
    );
  });

  test('keeps duplicate command detection for real conflicts', () => {
    writeFile(
      tempRoot,
      'commands/recruiting/recruit.js',
      `module.exports = { data: { name: 'recruit' }, execute: async () => {} };`
    );
    writeFile(
      tempRoot,
      'commands/another-recruit.js',
      `module.exports = { data: { name: 'recruit' }, execute: async () => {} };`
    );

    const commands = new Collection();
    const result = loadCommandsIntoCollection({ commandsPath, collection: commands });

    expect(commands.size).toBe(1);
    expect(result.loadErrors).toHaveLength(1);
    expect(result.loadErrors[0].error.message).toContain('Duplicate command "recruit"');
  });
});
