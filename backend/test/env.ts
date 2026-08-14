// Loaded via jest.config.cjs's `setupFiles`, inside each test file's own
// worker context, before any application module (db.ts/server.ts/indexer.ts)
// is imported - those modules read process.env at import time.
import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.test"), override: true });
