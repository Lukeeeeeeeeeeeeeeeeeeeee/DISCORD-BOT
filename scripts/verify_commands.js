const fs = require('fs');
const path = require('path');
const { Collection } = require('discord.js');

const client = {
    commands: new Collection()
};

const commandsPath = path.join(__dirname, '../src/commands');
const IGNORE_COMMAND_DIRS = new Set(['recruiter-handlers']);
const IGNORE_COMMAND_FILES = new Set(['verify.js', 'recruiter-helpers.js']);

async function loadCommandsRecursively(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry) continue;
        const file = entry.name;
        const fullPath = path.join(dir, file);

        if (entry.isDirectory()) {
            if (IGNORE_COMMAND_DIRS.has(file)) continue;
            await loadCommandsRecursively(fullPath);
            continue;
        }

        if (!entry.isFile() || !file.endsWith('.js') || IGNORE_COMMAND_FILES.has(file)) continue;
        try {
            const cmd = require(fullPath);
            if (cmd && cmd.data && cmd.data.name && typeof cmd.execute === 'function') {
                client.commands.set(cmd.data.name, cmd);
                console.log(`Loaded command: ${cmd.data.name} from ${path.relative(commandsPath, fullPath)}`);
            } else {
                console.warn(`Skipping invalid command module: ${file}`);
            }
        } catch (e) {
            console.error(`Failed to load command ${file}:`, e);
        }
    }
}

console.log('Starting command verification...');
(async () => {
    try {
        await loadCommandsRecursively(commandsPath);
        console.log(`\nTotal commands loaded: ${client.commands.size}`);

        const expectedCommands = ['recruit', 'recruiter', 'leaderboard', 'recruitment_report', 'rookie_promote', 'invite', 'info', 'absent'];
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
})();
