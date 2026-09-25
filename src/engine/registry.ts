import {
  createFileRegistry,
  fromBinary,
  type DescMessage,
  type DescMethod,
  type DescService,
  type FileRegistry,
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import type { PrismaClient } from "../db/client.js";
import { ProcessError } from "./errors.js";
import { checkIcon, defaultTitle, monogramIcon } from "./icons.js";

export const PROTOCOLS = ["connect", "grpc", "grpcweb"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

export interface RegisteredMethod {
  readonly name: string;
  /** What a service task names: `package.Service/Method`. */
  readonly path: string;
  readonly inputType: string;
  readonly outputType: string;
  readonly kind: DescMethod["methodKind"];
}

export interface RegisteredService {
  readonly name: string;
  readonly baseUrl: string;
  readonly protocol: Protocol;
  /** What editors and the dashboard call it; defaults from the name. */
  readonly title: string;
  /** A data: URI; a generated monogram unless one was set. */
  readonly icon: string;
  /** Whether `icon` was set, rather than generated. */
  readonly customIcon: boolean;
  readonly methods: RegisteredMethod[];
  readonly updatedAt: Date;
}

/** Everything needed to call one method. */
export interface ResolvedMethod {
  readonly path: string;
  readonly service: DescService;
  readonly method: DescMethod;
  readonly baseUrl: string;
  readonly protocol: Protocol;
}

interface ServiceRow {
  readonly name: string;
  readonly baseUrl: string;
  readonly protocol: string;
  readonly descriptorSetId: string;
  readonly updatedAt: Date;
  readonly title: string | null;
  readonly icon: string | null;
}

/** How a service looks; unset fields keep their current value. */
export interface Appearance {
  readonly title?: string;
  readonly icon?: string;
}

/** How long a worker trusts its copy of the service table. */
const ROWS_TTL_MS = 5_000;

function methodInfo(service: DescService, method: DescMethod): RegisteredMethod {
  return {
    name: method.name,
    path: `${service.typeName}/${method.name}`,
    inputType: method.input.typeName,
    outputType: method.output.typeName,
    kind: method.methodKind,
  };
}

/** Split `package.Service/Method`. */
export function parseMethodPath(path: string): { service: string; method: string } {
  const slash = path.lastIndexOf("/");
  const service = path.slice(0, slash).replace(/^\//, "");
  const method = path.slice(slash + 1);
  if (slash < 0 || service === "" || method === "") {
    throw new ProcessError(
      `"${path}" is not a method: expected package.Service/Method`,
      "invalid_argument",
    );
  }
  return { service, method };
}

/**
 * The services struna can call from service tasks. A registration is a
 * protobuf descriptor set plus where its services run: every service in the
 * set, or a chosen few, get that base URL and protocol. Processes name only
 * `package.Service/Method`, so moving a service is a registry change, not a
 * redeploy.
 */
export class ServiceRegistry {
  /** Parsed descriptor sets by id; a set never changes once stored. */
  readonly #sets = new Map<string, Promise<FileRegistry>>();
  #rows: { readonly at: number; readonly byName: Map<string, ServiceRow> } | undefined;

  constructor(private readonly db: PrismaClient) {}

  /** Parse a serialized FileDescriptorSet, refusing anything unusable. */
  static parse(content: Uint8Array): FileRegistry {
    try {
      return createFileRegistry(fromBinary(FileDescriptorSetSchema, content));
    } catch (cause) {
      throw new ProcessError(
        `not a usable descriptor set (build one with \`buf build -o set.binpb\`, imports included): ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        "invalid_argument",
      );
    }
  }

  /** Every service a descriptor set describes. */
  static services(registry: FileRegistry): DescService[] {
    const services: DescService[] = [];
    for (const type of registry) if (type.kind === "service") services.push(type);
    return services.sort((a, b) => a.typeName.localeCompare(b.typeName));
  }

  /**
   * Register the services in `content` at `baseUrl`: all of them, or only
   * `options.services`. A service registered before is pointed at the new
   * descriptor set, URL and protocol.
   */
  async add(
    content: Uint8Array,
    baseUrl: string,
    options: { readonly services?: readonly string[]; readonly protocol?: string } & Appearance = {},
  ): Promise<RegisteredService[]> {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new ProcessError(`base URL "${baseUrl}" is not a URL`, "invalid_argument");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ProcessError(`base URL must be http or https, got ${url.protocol}`, "invalid_argument");
    }
    const protocol = options.protocol === undefined || options.protocol === "" ? "connect" : options.protocol;
    if (!(PROTOCOLS as readonly string[]).includes(protocol)) {
      throw new ProcessError(
        `protocol must be one of ${PROTOCOLS.join(", ")}, got "${protocol}"`,
        "invalid_argument",
      );
    }

    const described = ServiceRegistry.services(ServiceRegistry.parse(content));
    const wanted = options.services?.filter((name) => name !== "") ?? [];
    const unknown = wanted.filter((name) => !described.some((s) => s.typeName === name));
    if (unknown.length > 0) {
      throw new ProcessError(
        `the descriptor set has no ${unknown.join(", ")}; it describes ${
          described.map((s) => s.typeName).join(", ") || "no services"
        }`,
        "invalid_argument",
      );
    }
    const chosen = wanted.length > 0 ? described.filter((s) => wanted.includes(s.typeName)) : described;
    if (chosen.length === 0) {
      throw new ProcessError("the descriptor set describes no services", "invalid_argument");
    }

    const normalizedUrl = url.toString().replace(/\/$/, "");
    const appearance = this.#appearance(options);
    await this.db.$transaction(async (tx) => {
      const set = await tx.descriptorSet.create({ data: { content: Buffer.from(content) } });
      for (const service of chosen) {
        await tx.service.upsert({
          where: { name: service.typeName },
          create: { name: service.typeName, baseUrl: normalizedUrl, protocol, descriptorSetId: set.id, ...appearance },
          update: { baseUrl: normalizedUrl, protocol, descriptorSetId: set.id, ...appearance },
        });
      }
    });
    await this.#dropOrphanSets();
    this.#rows = undefined;

    const names = new Set(chosen.map((s) => s.typeName));
    return (await this.list()).filter((service) => names.has(service.name));
  }

  async list(): Promise<RegisteredService[]> {
    const rows = await this.db.service.findMany({ orderBy: { name: "asc" } });
    return Promise.all(
      rows.map(async (row) => {
        const service = (await this.#set(row.descriptorSetId)).getService(row.name);
        return {
          name: row.name,
          baseUrl: row.baseUrl,
          protocol: row.protocol as Protocol,
          title: row.title ?? defaultTitle(row.name),
          icon: row.icon ?? monogramIcon(row.name),
          customIcon: row.icon !== null,
          methods: service === undefined ? [] : service.methods.map((m) => methodInfo(service, m)),
          updatedAt: row.updatedAt,
        };
      }),
    );
  }

  /** Each registered service with its schema, for generating editor templates. */
  async describe(): Promise<{ readonly service: RegisteredService; readonly desc: DescService }[]> {
    const services = await this.list();
    const rows = new Map((await this.db.service.findMany()).map((row) => [row.name, row]));
    const described = await Promise.all(
      services.map(async (service) => {
        const row = rows.get(service.name);
        const desc = row === undefined ? undefined : (await this.#set(row.descriptorSetId)).getService(service.name);
        return desc === undefined ? undefined : { service, desc };
      }),
    );
    return described.filter((entry) => entry !== undefined);
  }

  /** Set a service's title or icon; an empty string goes back to the default. */
  async setAppearance(name: string, appearance: Appearance): Promise<RegisteredService> {
    const data = this.#appearance(appearance, true);
    const { count } = await this.db.service.updateMany({ where: { name }, data });
    if (count === 0) throw new ProcessError(`no service ${name} is registered`, "not_found");
    const service = (await this.list()).find((s) => s.name === name);
    return service as RegisteredService;
  }

  /** Validated columns for an appearance; `clearable` lets "" reset to default. */
  #appearance(appearance: Appearance, clearable = false): { title?: string | null; icon?: string | null } {
    const data: { title?: string | null; icon?: string | null } = {};
    if (appearance.title !== undefined) {
      const title = appearance.title.trim();
      if (title !== "") data.title = title;
      else if (clearable) data.title = null;
    }
    if (appearance.icon !== undefined) {
      if (appearance.icon !== "") data.icon = checkIcon(appearance.icon);
      else if (clearable) data.icon = null;
    }
    return data;
  }

  async remove(name: string): Promise<void> {
    const { count } = await this.db.service.deleteMany({ where: { name } });
    if (count === 0) throw new ProcessError(`no service ${name} is registered`, "not_found");
    await this.#dropOrphanSets();
    this.#rows = undefined;
  }

  /** The service and method behind `package.Service/Method`, and where it runs. */
  async resolve(path: string): Promise<ResolvedMethod> {
    const { service: serviceName, method: methodName } = parseMethodPath(path);
    let row = (await this.#rowsByName()).get(serviceName);
    if (row === undefined) {
      // Maybe registered a moment ago by another process.
      this.#rows = undefined;
      row = (await this.#rowsByName()).get(serviceName);
    }
    if (row === undefined) {
      throw new ProcessError(
        `service ${serviceName} is not registered (struna services add --descriptor … --url …)`,
        "not_found",
      );
    }
    const service = (await this.#set(row.descriptorSetId)).getService(serviceName);
    const method = service?.methods.find((m) => m.name === methodName);
    if (service === undefined || method === undefined) {
      throw new ProcessError(
        `${serviceName} has no method ${methodName}; it has ${
          service?.methods.map((m) => m.name).join(", ") ?? "none"
        }`,
        "not_found",
      );
    }
    if (method.methodKind !== "unary") {
      throw new ProcessError(
        `${path} is a ${method.methodKind.replace("_", "-")} method; service tasks call unary methods`,
        "invalid_argument",
      );
    }
    return {
      path: `${serviceName}/${methodName}`,
      service,
      method,
      baseUrl: row.baseUrl,
      protocol: row.protocol as Protocol,
    };
  }

  async #rowsByName(): Promise<Map<string, ServiceRow>> {
    if (this.#rows === undefined || Date.now() - this.#rows.at > ROWS_TTL_MS) {
      const rows = await this.db.service.findMany();
      this.#rows = { at: Date.now(), byName: new Map(rows.map((row) => [row.name, row])) };
    }
    return this.#rows.byName;
  }

  #set(id: string): Promise<FileRegistry> {
    let set = this.#sets.get(id);
    if (set === undefined) {
      set = this.db.descriptorSet
        .findUniqueOrThrow({ where: { id }, select: { content: true } })
        .then((row) => ServiceRegistry.parse(row.content));
      set.catch(() => this.#sets.delete(id));
      this.#sets.set(id, set);
    }
    return set;
  }

  /** Descriptor sets no service points at any more. */
  async #dropOrphanSets(): Promise<void> {
    await this.db.descriptorSet.deleteMany({ where: { services: { none: {} } } });
  }
}

/** A field of `message` by its proto or JSON name. */
export function findField(message: DescMessage, name: string) {
  return message.fields.find((field) => field.name === name || field.jsonName === name);
}
