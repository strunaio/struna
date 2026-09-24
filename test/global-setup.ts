import { execFileSync } from "node:child_process";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/gen/prisma/client.js";

// Vitest does not read .env; load it here, as the CLI does, so a local
// TEST_DATABASE_URL applies. Variables already set in the environment win.
try {
  process.loadEnvFile();
} catch {
  // No .env: fall back to the compose default below.
}

/**
 * The suite's own database, next to the dev one in compose.yaml. CI (or a
 * different local setup) can point it elsewhere with TEST_DATABASE_URL.
 */
export const TEST_DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ??
  "postgresql://struna:struna@localhost:5433/struna_test";

/**
 * Wipe the test database and apply the migrations once before the suite
 * runs, so the tests also prove the migrations build the schema.
 *
 * This drops everything in `public`, so it only ever touches a database whose
 * name ends in `_test` — a mistyped TEST_DATABASE_URL pointing at a real
 * database fails here instead of emptying it.
 */
export default async function setup(): Promise<void> {
  const name = decodeURIComponent(new URL(TEST_DATABASE_URL).pathname.slice(1));
  if (!name.endsWith("_test")) {
    throw new Error(
      `refusing to reset database ${JSON.stringify(name)}: ` +
        "TEST_DATABASE_URL must name a database ending in _test",
    );
  }

  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL }),
  });
  try {
    await db.$executeRawUnsafe("DROP SCHEMA IF EXISTS public CASCADE");
    await db.$executeRawUnsafe("CREATE SCHEMA public");
  } finally {
    await db.$disconnect();
  }

  execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "ignore",
  });
}
