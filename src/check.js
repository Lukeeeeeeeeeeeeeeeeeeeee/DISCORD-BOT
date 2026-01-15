require('dotenv').config();
const db = require('./db');
const fs = require('fs');

console.log('DB path:', process.env.DATABASE_PATH || './data/recruiter.db');
console.log('Tables:');
const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log(rows.map(r=>r.name));
console.log('Sample recruiters:', db.prepare('SELECT * FROM recruiters LIMIT 5').all());
console.log('OK');