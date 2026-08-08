const fs = require('fs');
const readline = require('readline');
const path = require('path');

async function extractAECSLog() {
    const logFile = path.resolve(__dirname, 'data/aecs/aecs-2026-03-03.jsonl');
    if (!fs.existsSync(logFile)) {
        console.error('File not found:', logFile);
        return;
    }

    const fileStream = fs.createReadStream(logFile);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    let latestFullError = null;
    let linesRead = 0;

    for await (const line of rl) {
        linesRead++;
        if (line.includes('command.recruit.execute.outer')) {
            console.log("FOUND LATEST ERROR MATCH:");
            console.log(line);
            latestFullError = true;
        }
    }

    if (latestFullError) {
        console.log("FOUND LATEST ERROR:");
        console.log(JSON.stringify(latestFullError, null, 2));
    } else {
        console.log("No exact match found in", linesRead, "lines");
    }
}

extractAECSLog().catch(console.error);
