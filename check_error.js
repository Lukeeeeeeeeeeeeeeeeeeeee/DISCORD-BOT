const db = require('./src/db_async');
async function run() {
  const row = await db.get("SELECT * FROM aecs_events WHERE support_id = 'TSLAL8W'");
  if (row) {
    console.log(JSON.stringify(row, null, 2));
  } else {
    console.log("Not found in DB");
  }
  process.exit(0);
}
run();
