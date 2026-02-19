const os = require('os');
const path = require('path');

if (!process.env.ANTINUKE_DATA_FILE) {
  process.env.ANTINUKE_DATA_FILE = path.join(
    os.tmpdir(),
    `antinuke-state-jest-${process.pid}-${Date.now()}.json`
  );
}
