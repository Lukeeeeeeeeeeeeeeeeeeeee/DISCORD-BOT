const path = require('path');
const { Collection } = require('discord.js');
const { loadCommandsIntoCollection } = require('../src/lib/command-loader');

const client = {
  commands: new Collection()
};

const commandsPath = path.join(__dirname, '../src/commands');

console.log('Starting command verification...');
try {
  const { loadErrors } = loadCommandsIntoCollection({
    commandsPath,
    collection: client.commands,
    onLoad: ({ commandName, relPath }) => {
      console.log(`Loaded command: ${commandName} from ${relPath}`);
    },
    onWarn: (message) => {
      console.warn(message);
    }
  });

  if (loadErrors.length > 0) {
    console.error('\nCommand verification failed due to load errors:');
    for (const failure of loadErrors) {
      const message = failure && failure.error && failure.error.message ? failure.error.message : String(failure.error);
      console.error(`- ${failure.file}: ${message}`);
    }
    process.exit(1);
  }

  console.log(`\nTotal commands loaded: ${client.commands.size}`);

  const expectedCommands = ['recruit', 'recruiter', 'leaderboard', 'rookiepoints', 'rookie_promote', 'invite', 'info', 'absent', 'status'];
  const missing = expectedCommands.filter(c => !client.commands.has(c));

  if (missing.length > 0) {
    console.error('Missing expected commands:', missing);
    process.exit(1);
  } else {
    console.log('All key recruiting commands found.');
    process.exit(0);
  }
} catch (e) {
  console.error('Verification failed:', e);
  process.exit(1);
}
