import { readFileSync } from "node:fs";
import { Command } from "commander";
import { loadEnvFile, workerConfig } from "../config.js";
import { assertSchema, disconnectPrisma, prisma } from "../db/client.js";
import { ProcessError } from "../engine/errors.js";
import { iconFromFile } from "../engine/icons.js";
import { ServiceRegistry, type RegisteredService } from "../engine/registry.js";

interface DbOptions {
  databaseUrl?: string;
}

/** Run `action` against the registry, then close the database either way. */
async function withRegistry(
  options: DbOptions,
  action: (registry: ServiceRegistry) => Promise<void>,
): Promise<void> {
  loadEnvFile();
  const config = workerConfig(options.databaseUrl === undefined ? {} : { databaseUrl: options.databaseUrl });
  const db = prisma(config.databaseUrl);
  try {
    await assertSchema(db);
    await action(new ServiceRegistry(db));
  } catch (cause) {
    // A refusal is the user's to fix: say why, without a stack trace.
    if (!(cause instanceof ProcessError)) throw cause;
    process.stderr.write(`struna: ${cause.message}\n`);
    process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }
}

function print(services: RegisteredService[]): void {
  if (services.length === 0) {
    process.stdout.write("No services registered.\n");
    return;
  }
  for (const service of services) {
    const icon = service.customIcon ? "custom icon" : "default icon";
    process.stdout.write(`${service.name}  "${service.title}"  ${service.protocol}  ${service.baseUrl}  (${icon})\n`);
    for (const method of service.methods) {
      const note = method.kind === "unary" ? "" : `  (${method.kind}: not callable from service tasks)`;
      process.stdout.write(`  ${method.path}${note}\n`);
    }
  }
}

/**
 * `struna services`: the registry of Connect/gRPC services service tasks can
 * call. Talks to the database directly, like `struna worker`.
 */
export function servicesCommand(): Command {
  const collect = (value: string, previous: string[]) => [...previous, value];

  const add = new Command("add")
    .description("Register the services in a descriptor set (buf build -o set.binpb) at a base URL")
    .requiredOption("--descriptor <file>", "serialized FileDescriptorSet, imports included")
    .requiredOption("--url <baseUrl>", "where the services run, e.g. https://acme-api.run.app")
    .option("--service <name>", "only this service (repeatable); default: every service in the set", collect, [])
    .option("--protocol <protocol>", "connect (default), grpc or grpcweb")
    .option("--title <title>", "name shown in editors and on diagrams (default: from the service name)")
    .option("--icon <file>", "an .svg or .png icon (default: a generated monogram)")
    .option("--database-url <url>", "override DATABASE_URL")
    .action(
      async (
        options: DbOptions & {
          descriptor: string;
          url: string;
          service: string[];
          protocol?: string;
          title?: string;
          icon?: string;
        },
      ) => {
        const content = readFileSync(options.descriptor);
        await withRegistry(options, async (registry) => {
          const services = await registry.add(content, options.url, {
            services: options.service,
            ...(options.protocol === undefined ? {} : { protocol: options.protocol }),
            ...(options.title === undefined ? {} : { title: options.title }),
            ...(options.icon === undefined ? {} : { icon: iconFromFile(options.icon) }),
          });
          process.stdout.write(`Registered ${services.length} service(s):\n`);
          print(services);
        });
      },
    );

  const list = new Command("list")
    .description("List registered services and their methods")
    .option("--database-url <url>", "override DATABASE_URL")
    .action(async (options: DbOptions) => {
      await withRegistry(options, async (registry) => print(await registry.list()));
    });

  const remove = new Command("remove")
    .description("Unregister a service")
    .argument("<name>", "full service name, e.g. acme.slack.v1.ChatService")
    .option("--database-url <url>", "override DATABASE_URL")
    .action(async (name: string, options: DbOptions) => {
      await withRegistry(options, async (registry) => {
        await registry.remove(name);
        process.stdout.write(`Removed ${name}.\n`);
      });
    });

  const appearance = new Command("appearance")
    .description("Set how a service looks in editors and on diagrams")
    .argument("<name>", "full service name, e.g. acme.slack.v1.ChatService")
    .option("--title <title>", "its name; \"\" goes back to the default")
    .option("--icon <file>", "an .svg or .png icon")
    .option("--default-icon", "go back to the generated icon")
    .option("--database-url <url>", "override DATABASE_URL")
    .action(
      async (name: string, options: DbOptions & { title?: string; icon?: string; defaultIcon?: boolean }) => {
        await withRegistry(options, async (registry) => {
          const service = await registry.setAppearance(name, {
            ...(options.title === undefined ? {} : { title: options.title }),
            ...(options.defaultIcon === true
              ? { icon: "" }
              : options.icon === undefined
                ? {}
                : { icon: iconFromFile(options.icon) }),
          });
          print([service]);
          process.stdout.write("Run `struna templates export` to update editor templates.\n");
        });
      },
    );

  return new Command("services")
    .description("Manage the Connect/gRPC services that service tasks call")
    .addCommand(add)
    .addCommand(list)
    .addCommand(appearance)
    .addCommand(remove);
}
