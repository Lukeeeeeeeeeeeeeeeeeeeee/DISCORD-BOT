const fs = require('fs');
const path = require('path');

async function testShutdownCorruption() {
    console.log('Running Diagnostic: Shutdown File Truncation Race (Pass C)');

    const testFile = path.resolve('./data/test_antinuke_truncate.json');

    // Create a large mock state (simulate a real Antinuke state)
    const hugeState = { payload: 'A'.repeat(50 * 1024 * 1024) }; // 50MB

    // The vulnerability: antinuke.js uses 'fs.writeFile' directly to the active data file.
    // If SIGKILL arrives mid-write, the file is destroyed.

    // Phase 1: Simulate the write
    let writePromise = fs.promises.writeFile(testFile, JSON.stringify(hugeState));

    // Phase 2: Simulate SIGKILL 5 milliseconds into the write
    setTimeout(() => {
        console.log('[!] Systemd SIGKILL received. Process forcefully terminating (simulated).');

        // We check the file size right now. Node's fs.writeFile truncates the file 
        // to 0 bytes immediately upon opening it for writing, before streaming data.
        try {
            const stats = fs.statSync(testFile);
            console.log(`[+] File size at moment of SIGKILL: ${stats.size} bytes`);

            if (stats.size < 50000000) {
                console.log('[-] VULNERABILITY CONFIRMED: The file is partially written or 0 bytes.');
                console.log('    Upon next boot, JSON.parse() will throw an error and Anti-Nuke will wipe all data.');
            }
        } catch (e) {
            console.error(e);
        }

        // Cleanup
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
        process.exit(0);
    }, 5);
}

testShutdownCorruption().catch(console.error);
