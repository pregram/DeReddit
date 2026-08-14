import type { PoolClient } from "pg";
import pool from "../db.js";

/**
 * Run `work` inside an atomic PostgreSQL transaction.
 *
 * @param work  An async function that receives an already-connected PoolClient
 *              with an active transaction. It must NOT call COMMIT or ROLLBACK.
 * @returns     Whatever `work` returns.
 * @throws      Re-throws any error from `work` after rolling back.
 */
export async function runInTransaction<T>(
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // Log but do not suppress the original error
      console.error("[tx] ROLLBACK failed:", rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}