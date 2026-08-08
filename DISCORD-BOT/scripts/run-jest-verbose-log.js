const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const outputArg = process.argv[2] || 'failures.txt';
const outputPath = path.resolve(process.cwd(), outputArg);
const out = fs.createWriteStream(outputPath, { flags: 'w' });

function writeBoth(chunk, target) {
  if (!chunk) return;
  target.write(chunk);
  out.write(chunk);
}

const jestBin = require.resolve('jest/bin/jest');
const child = spawn(process.execPath, [jestBin, '--verbose', '--no-cache', '--runInBand'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe']
});

child.stdout.on('data', (chunk) => writeBoth(chunk, process.stdout));
child.stderr.on('data', (chunk) => writeBoth(chunk, process.stderr));
child.on('error', (error) => {
  writeBoth(`Failed to start jest: ${error.message}\n`, process.stderr);
  out.end(() => process.exit(1));
});
child.on('close', (code) => {
  out.end(() => process.exit(code == null ? 1 : code));
});
