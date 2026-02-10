const fs = require('fs');
const path = require('path');
const { Collection } = require('discord.js');

const client = {
    commands: new Collection()
};

const commandsPath = path.join(__dirname, '../src/commands');

function loadCommandsRecursively(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            loadCommandsRecursively(fullPath);
        } else if (file.endsWith('.js') && file !== 'verify.js') {
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
}

console.log('Starting command verification...');
try {
    loadCommandsRecursively(commandsPath);
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
