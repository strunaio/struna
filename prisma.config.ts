import path from "node:path";
import { defineConfig } from "prisma/config";

// Prisma 7 no longer reads .env implicitly, and it no longer accepts a `url`
// in schema.prisma. The CLI (migrate, db push, studio) reads it from here;
// the runtime client gets its connection from a driver adapter instead —
// see src/db/client.ts.
try {
  process.loadEnvFile();
} catch {
  // No .env present; rely on the ambient environment.
}

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: { path: path.join("prisma", "migrations") },
  datasource: {
    // Keep in step with DEFAULT_DATABASE_URL in src/config.ts.
    url: process.env["DATABASE_URL"] ?? "postgresql://struna:struna@localhost:5433/struna",
  },
});
