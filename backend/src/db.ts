import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// pg emits "error" on idle clients that lose their connection (e.g. a network blip).
// Without a listener that's an unhandled event and crashes the process.
pool.on("error", (err) => {
  console.error("[DB] Unexpected pool error:", err.message);
});

export default pool;