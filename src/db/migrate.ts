import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool } from "../config/database.js";

async function runMigrations() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        migration_name VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationsPath = resolve(process.cwd(), "src/db/migrations");
    const migrationNames = (await readdir(migrationsPath))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();

    for (const migrationName of migrationNames) {
      const existing = await client.query(
        "SELECT id FROM schema_migrations WHERE migration_name = $1",
        [migrationName]
      );

      if (existing.rowCount && existing.rowCount > 0) {
        console.log("Migration already applied:", migrationName);
        continue;
      }

      const sql = await readFile(resolve(migrationsPath, migrationName), "utf-8");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (migration_name) VALUES ($1)",
        [migrationName]
      );
      console.log("Migration completed:", migrationName);
    }

    await client.query("COMMIT");

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();