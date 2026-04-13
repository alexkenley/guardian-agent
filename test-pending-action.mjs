import sqlite3 from 'sqlite3';
import path from 'path';
import os from 'os';

const dbPath = path.join(os.homedir(), '.guardianagent', 'state', 'pending-actions.sqlite');

const db = new sqlite3.Database(dbPath);

db.all('SELECT * FROM pending_actions ORDER BY created_at DESC LIMIT 5', (err, rows) => {
  if (err) {
    console.error(err);
    return;
  }
  rows.forEach(row => {
    console.log(`Action ID: ${row.id}`);
    console.log(`Intent: ${row.intent}`);
    console.log(`Resume: ${row.resume}`);
    console.log('---');
  });
});
