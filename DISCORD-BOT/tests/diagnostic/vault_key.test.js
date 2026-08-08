const AntiNuke = require('../../src/lib/antinuke');
const assert = require('assert');

// Mock a barebones Discord client
const mockClient = {
    on: () => { },
    user: { id: 'bot-id' },
    guilds: { cache: new Map() }
};

function testVaultKeyMisconfiguration() {
    console.log('Running Diagnostic: Vault Key Missing State');

    // Environment 1: Required is true, Key is missing (Should Throw)
    try {
        process.env.ANTINUKE_ENCRYPTION_KEY = '';
        process.env.ANTINUKE_REQUIRE_ENCRYPTION = 'true';
        const an1 = new AntiNuke(mockClient);
        const mockSnapshot = { test: 'data' };
        an1.encryptSnapshot(mockSnapshot);
        console.error('[-] FAIL: Expected it to throw when taking a snapshot without a key and required=true.');
    } catch (err) {
        console.log('[+] SUCCESS: Vault correctly throws if required=true and key missing.');
        console.log(`    Error Message Caught: ${err.message}`);
    }

    // Environment 2: Required is false, Key is missing (Silent plaintext fallback)
    try {
        process.env.ANTINUKE_ENCRYPTION_KEY = '';
        process.env.ANTINUKE_REQUIRE_ENCRYPTION = 'false';
        process.env.ANTINUKE_ALLOW_UNENCRYPTED_BACKUPS = 'true';
        const an2 = new AntiNuke(mockClient);

        // An admin accidentally deployed with require=false
        const mockSnapshot = { secret_role: 'administrator' };
        const result = an2.encryptSnapshot(mockSnapshot);

        console.log('[+] Diagnostic Finding:');
        assert.strictEqual(result.encrypted, false);
        console.log('    Snapshots are saved as plaintext: ', result);
    } catch (err) {
        console.error('[-] FAIL unexpectedly', err);
    }
}

testVaultKeyMisconfiguration();
