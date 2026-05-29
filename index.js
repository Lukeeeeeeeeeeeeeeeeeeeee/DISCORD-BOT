const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = __dirname;
const packageJson = path.join(root, 'package.json');
const dotenvPackage = path.join(root, 'node_modules', 'dotenv');

function installDependencies() {
  if (!fs.existsSync(packageJson)) return;
  console.log('Missing dependencies detected; running npm install...');
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCmd, ['install'], { stdio: 'inherit', cwd: root });

  if (result.error || result.status !== 0) {
    console.error('npm install failed', result.error || `exit ${result.status}`);
    process.exit(result.status || 1);
  }
}

if (!fs.existsSync(dotenvPackage) && fs.existsSync(packageJson)) {
  installDependencies();
}

require('dotenv').config();
require('./src/index.js');
