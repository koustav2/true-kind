// One Sequelize instance for the whole app. Dialect is configurable:
//   DB_DIALECT=postgres  -> the same Postgres that runs TRUE HRMS (its own
//                           `truekind` database, created automatically)
//   DB_DIALECT=mysql     -> any MySQL server
//   DB_DIALECT=sqlite    -> in-memory, used by the smoke test
const { Sequelize } = require('sequelize');

const DIALECT = process.env.DB_DIALECT || 'postgres';

let sequelize;
if (DIALECT === 'sqlite') {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
} else {
  sequelize = new Sequelize(
    process.env.DB_NAME || 'truekind',
    process.env.DB_USER || (DIALECT === 'postgres' ? 'truehr' : 'root'),
    process.env.DB_PASS || '',
    {
      host: process.env.DB_HOST || '127.0.0.1',
      port: +(process.env.DB_PORT || (DIALECT === 'postgres' ? 5432 : 3306)),
      dialect: DIALECT,
      logging: false
    }
  );
}

// Create the `truekind` database if missing. Never touches other databases
// (the HRMS one included) — it only issues CREATE DATABASE for our own name.
async function ensureDatabase() {
  const name = process.env.DB_NAME || 'truekind';
  if (DIALECT === 'sqlite') return;
  if (DIALECT === 'postgres') {
    const { Client } = require('pg');
    const client = new Client({
      host: process.env.DB_HOST || '127.0.0.1',
      port: +(process.env.DB_PORT || 5432),
      user: process.env.DB_USER || 'truehr',
      password: process.env.DB_PASS || '',
      database: process.env.DB_ADMIN_DB || 'postgres'   // maintenance DB to connect through
    });
    await client.connect();
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!exists.rowCount) await client.query(`CREATE DATABASE "${name}"`);
    await client.end();
  } else {
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST || '127.0.0.1',
      port: +(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || ''
    });
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\``);
    await conn.end();
  }
}

module.exports = { sequelize, ensureDatabase };
