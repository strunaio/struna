import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { loadEnvFile, workerConfig } from "../config.js";
import { assertSchema, disconnectPrisma, prisma } from "../db/client.js";
import { ServiceRegistry } from "../engine/registry.js";
import { applyTemplates, serviceTemplates, templateFileName } from "../engine/templates.js";
import { serviceTaskMethods } from "../server/element-definition.js";

/** Where Camunda Modeler and the BPMN Modeler extension look for templates. */
const DEFAULT_OUT = ".camunda/element-templates";

/**
 * Write the element templates for every registered service: one file per
 * service, one template per unary method, all with the service's icon.
 * Files for services no longer registered are removed; other files in the
 * folder are left alone.
 */
export async function exportTemplates(registry: ServiceRegistry, out: string): Promise<string[]> {
  mkdirSync(out, { recursive: true });
  const written: string[] = [];
  for (const { service, desc } of await registry.describe()) {
    const templates = serviceTemplates(service, desc);
    if (templates.length === 0) continue;
    const file = path.join(out, templateFileName(service.name));
    writeFileSync(file, `${JSON.stringify(templates, null, 2)}\n`);
    written.push(file);
  }
  const keep = new Set(written.map((file) => path.basename(file)));
  for (const name of readdirSync(out)) {
    if (name.startsWith("struna-") && name.endsWith(".json") && !keep.has(name)) {
      rmSync(path.join(out, name));
    }
  }
  return written;
}

/**
 * Stamp template ids and service icons onto the service tasks of BPMN files,
 * as picking the template in an editor would. Returns the tasks set per file.
 */
export async function applyToFiles(registry: ServiceRegistry, files: string[]): Promise<Record<string, string[]>> {
  const icons: Record<string, string> = {};
  for (const { service, desc } of await registry.describe()) {
    for (const method of desc.methods) icons[`${desc.typeName}/${method.name}`] = service.icon;
  }
  const result: Record<string, string[]> = {};
  for (const file of files) {
    const xml = readFileSync(file, "utf8");
    const methods = await serviceTaskMethods(`file:${file}:${xml.length}`, xml);
    const { xml: out, applied } = applyTemplates(xml, methods, icons);
    if (out !== xml) writeFileSync(file, out);
    result[file] = applied;
  }
  return result;
}

export function templatesCommand(): Command {
  const exportCommand = new Command("export")
    .description("Write element templates for the registered services, for BPMN editors")
    .option("--out <dir>", "output folder", DEFAULT_OUT)
    .option("--database-url <url>", "override DATABASE_URL")
    .action(async (options: { out: string; databaseUrl?: string }) => {
      loadEnvFile();
      const config = workerConfig(options.databaseUrl === undefined ? {} : { databaseUrl: options.databaseUrl });
      const db = prisma(config.databaseUrl);
      try {
        await assertSchema(db);
        const written = await exportTemplates(new ServiceRegistry(db), options.out);
        process.stdout.write(
          written.length === 0
            ? "No services registered; nothing to write.\n"
            : `Wrote ${written.length} template file(s):\n${written.map((f) => `  ${f}\n`).join("")}` +
                "Reopen the diagram in your editor to pick them up.\n",
        );
      } finally {
        await disconnectPrisma();
      }
    });

  const applyCommand = new Command("apply")
    .description("Link service tasks in BPMN files to their templates, so editors show the service icons")
    .argument("<files...>", "BPMN files to update in place")
    .option("--database-url <url>", "override DATABASE_URL")
    .action(async (files: string[], options: { databaseUrl?: string }) => {
      loadEnvFile();
      const config = workerConfig(options.databaseUrl === undefined ? {} : { databaseUrl: options.databaseUrl });
      const db = prisma(config.databaseUrl);
      try {
        await assertSchema(db);
        const result = await applyToFiles(new ServiceRegistry(db), files);
        for (const [file, tasks] of Object.entries(result)) {
          process.stdout.write(
            tasks.length === 0
              ? `${file}: no service tasks of registered services\n`
              : `${file}: ${tasks.join(", ")}\n`,
          );
        }
      } finally {
        await disconnectPrisma();
      }
    });

  return new Command("templates")
    .description("Element templates for BPMN editors (Camunda Modeler, VS Code BPMN Modeler)")
    .addCommand(exportCommand)
    .addCommand(applyCommand);
}
