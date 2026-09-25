import { timingSafeEqual } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import {
  RegisteredServiceSchema,
  RegistryService,
  ServiceMethodSchema,
} from "../gen/struna/v1/registry_pb.js";
import { ProcessError } from "../engine/errors.js";
import type { RegisteredService, ServiceRegistry } from "../engine/registry.js";

function serviceMessage(service: RegisteredService) {
  return create(RegisteredServiceSchema, {
    name: service.name,
    baseUrl: service.baseUrl,
    protocol: service.protocol,
    methods: service.methods.map((method) => create(ServiceMethodSchema, method)),
    updatedAt: timestampFromDate(service.updatedAt),
  });
}

function toConnectError(cause: unknown): ConnectError {
  if (cause instanceof ProcessError) {
    return new ConnectError(
      cause.message,
      cause.code === "not_found" ? Code.NotFound : Code.InvalidArgument,
    );
  }
  return ConnectError.from(cause, Code.Internal);
}

/**
 * The service registry over RPC. It decides which URLs struna calls, so
 * without an admin token it is off, and with one every call must carry it.
 */
export function registryRoutes(registry: ServiceRegistry, adminToken: string | undefined) {
  const guard = (context: HandlerContext): void => {
    if (adminToken === undefined) {
      throw new ConnectError(
        "the registry API is disabled; set STRUNA_ADMIN_TOKEN, or use `struna services`",
        Code.PermissionDenied,
      );
    }
    const expected = Buffer.from(`Bearer ${adminToken}`);
    const actual = Buffer.from(context.requestHeader.get("authorization") ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new ConnectError("missing or invalid admin token", Code.Unauthenticated);
    }
  };

  return (router: ConnectRouter): void => {
    router.service(RegistryService, {
      async addServices(req, context) {
        guard(context);
        try {
          const services = await registry.add(req.descriptorSet, req.baseUrl, {
            services: req.services,
            protocol: req.protocol,
          });
          return { services: services.map(serviceMessage) };
        } catch (cause) {
          throw toConnectError(cause);
        }
      },
      async listServices(_req, context) {
        guard(context);
        return { services: (await registry.list()).map(serviceMessage) };
      },
      async removeService(req, context) {
        guard(context);
        try {
          await registry.remove(req.name);
          return {};
        } catch (cause) {
          throw toConnectError(cause);
        }
      },
    });
  };
}
