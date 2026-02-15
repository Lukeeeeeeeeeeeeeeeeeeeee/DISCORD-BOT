const fs = require('fs');
const path = require('path');
const { Collection } = require('discord.js');

const client = {
    commands: new Collection()
};
const commandSourceByName = new Map();
const loadFailures = [];

const commandsPath = path.join(__dirname, '../src/commands');

function shouldIgnoreCommandModule(fullPath) {
    const normalized = fullPath.split(path.sep).join('/');
    if (normalized.includes('/recruiter-handlers/')) return true;
    const base = path.basename(fullPath).toLowerCase();
    if (base === 'recruiter.js' && normalized.endsWith('/commands/recruiter.js')) return true;
    if (base === 'recruitment_report.js') return true;
    if (base.endsWith('-helpers.js')) return true;
    if (base === 'verify.js') return true;
    return false;
}

function loadCommandsRecursively(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            loadCommandsRecursively(fullPath);
        } else if (file.endsWith('.js')) {
            if (shouldIgnoreCommandModule(fullPath)) continue;
            try {
                const cmd = require(fullPath);
                if (cmd && cmd.data && cmd.data.name && typeof cmd.execute === 'function') {
                    const relPath = path.relative(commandsPath, fullPath);
                    const existingPath = commandSourceByName.get(cmd.data.name);
                    if (existingPath) {
                        throw new Error(`Duplicate command "${cmd.data.name}" from ${relPath} and ${existingPath}`);
                    }
                    commandSourceByName.set(cmd.data.name, relPath);
                    client.commands.set(cmd.data.name, cmd);
                    console.log(`Loaded command: ${cmd.data.name} from ${relPath}`);
                } else {
                    console.warn(`Skipping invalid command module: ${file}`);
                }
            } catch (e) {
                console.error(`Failed to load command ${file}:`, e);
                loadFailures.push({ file, error: e });
            }
        }
    }
}

console.log('Starting command verification...');
try {
    loadCommandsRecursively(commandsPath);
    if (loadFailures.length > 0) {
        console.error('\nCommand verification failed due to load errors:');
        for (const failure of loadFailures) {
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
