const { spawn } = require('child_process');

const testFiles = [
  'tests/antinuke_integration.test.js',
  'tests/antinuke_wait_for_audit_log.test.js',
  'tests/antinuke_rollback_prune.test.js',
  'tests/voice_state_update_handler.test.js',
  'tests/integration_recruit_flow.test.js'
];

const jestBin = require.resolve('jest/bin/jest');
const child = spawn(
  process.execPath,
  [jestBin, '--runInBand', '--no-cache', ...testFiles],
  { stdio: 'inherit', env: process.env, cwd: process.cwd() }
);

child.on('close', (code) => {
  process.exit(code == null ? 1 : code);
});

child.on('error', (error) => {
  console.error('Failed to run P0 regression suite', error);
  process.exit(1);
});
