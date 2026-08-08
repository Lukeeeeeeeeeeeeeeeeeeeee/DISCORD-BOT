const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('data/bot.sqlite', (err) => {
  if (err) return console.error(err);
  db.all("PRAGMA table_info(recruits)", (err, rows) => {
    console.log("RECRUITS SCHEMA:", rows);
    db.all("SELECT * FROM dm_cancellations LIMIT 1", (err, rows2) => {
       console.log("CANCELLATIONS:", err ? err.message : rows2);
       process.exit(0);
    });
  });
});
