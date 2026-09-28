const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('./config');

async function migrate() {
  // Create the database itself if the user has the privilege; ignore otherwise.
  const { database, ...server } = config.db;
  const admin = await mysql.createConnection({ ...server, multipleStatements: true });
  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } catch (_) { /* no CREATE privilege: database must already exist */ }
  await admin.changeUser({ database });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  await admin.query(sql);
  await admin.end();
}

module.exports = migrate;

if (require.main === module) {
  migrate()
    .then(() => { console.log('Database schema is up to date'); process.exit(0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
