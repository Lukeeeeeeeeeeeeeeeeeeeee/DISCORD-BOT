const os = require('os');
const path = require('path');

if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = path.join(
    os.tmpdir(),
    `recruiter-jest-${process.pid}-${Date.now()}.db`
  );
}

if (!process.env.ANTINUKE_DATA_FILE) {
  process.env.ANTINUKE_DATA_FILE = path.join(
    os.tmpdir(),
    `antinuke-state-jest-${process.pid}-${Date.now()}.json`
  );
}
