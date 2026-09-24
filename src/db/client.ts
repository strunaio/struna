import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../gen/prisma/client.js";

let client: PrismaClient | undefined;

/**
 * Lazily construct the process-wide Prisma client. Prisma 7 takes its
 * connection through a driver adapter rather than a schema-level url.
 */
export function prisma(databaseUrl: string): PrismaClient {
  if (client === undefined) {
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
  }
  return client;
}

/**
 * Fail fast when the database predates the schema this build expects, rather
 * than letting every query fail later. P2021/P2022 are Prisma's "table" and
 * "column does not exist" errors.
 */
export async function assertSchema(db: PrismaClient): Promise<void> {
  try {
    await db.processInstance.findFirst({
      select: { runnableAt: true, lockedBy: true, lockedUntil: true },
    });
    await db.processSignal.findFirst({ select: { id: true } });
  } catch (cause) {
    const code = (cause as { code?: unknown }).code;
    if (code === "P2021" || code === "P2022") {
      throw new Error(
        "database schema is out of date — run `npm run db:migrate` (or `prisma migrate deploy`)",
        { cause },
      );
    }
    throw cause;
  }
}

export async function disconnectPrisma(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}

export type { PrismaClient };
