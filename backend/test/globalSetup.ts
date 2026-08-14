// Jest `globalSetup` - runs once in the main process before any test file
// worker starts. Ensures the dedicated `dereddit_test` database exists and
// has the current schema applied (backend/init.sql is idempotent: every
// CREATE TABLE/EXTENSION is IF NOT EXISTS, every view is CREATE OR REPLACE,
// so re-running it against an already-migrated test DB is safe).
import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import pg from "pg";

export default async function globalSetup(): Promise<void> {
  dotenv.config({ path: path.resolve(process.cwd(), ".env.test"), override: true });

  const testDbUrl = new URL(process.env.DATABASE_URL!);
  const testDbName = testDbUrl.pathname.replace(/^\//, "");

  const adminUrl = new URL(testDbUrl);
  adminUrl.pathname = "/postgres";

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    // Drop + recreate on every run instead of trying to reuse an existing
    // test DB: init.sql's CREATE TYPE statements aren't idempotent (no
    // IF NOT EXISTS support in Postgres for enum types), so a fresh
    // database is the simplest way to guarantee init.sql applies cleanly.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName]
    );
    await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(testDbName)}`);
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(testDbName)}`);
  } finally {
    await admin.end();
  }

  const initSql = fs.readFileSync(path.resolve(process.cwd(), "init.sql"), "utf8");
  const testDb = new pg.Client({ connectionString: testDbUrl.toString() });
  await testDb.connect();
  try {
    await testDb.query(initSql);
  } finally {
    await testDb.end();
  }
}
