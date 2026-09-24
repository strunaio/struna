import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { create, type JsonObject } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  InstanceStatus,
  ProcessDefinitionSchema,
  ProcessEventSchema,
  ProcessInstanceSchema,
  ProcessService,
  WatchInstanceResponseSchema,
} from "../gen/struna/v1/process_pb.js";
import { ProcessEngine, ProcessError } from "../engine/process-engine.js";

const MAX_PAGE_SIZE = 100;

const CODE_BY_REASON: Record<ProcessError["code"], Code> = {
  not_found: Code.NotFound,
  invalid_argument: Code.InvalidArgument,
  failed_precondition: Code.FailedPrecondition,
};

function toConnectError(cause: unknown): ConnectError {
  if (cause instanceof ProcessError) {
    return new ConnectError(cause.message, CODE_BY_REASON[cause.code]);
  }
  return ConnectError.from(cause, Code.Internal);
}

// protobuf-es represents google.protobuf.Struct fields as plain JSON objects,
// and jsonb columns come back as the same, so these are only default helpers.
function structFrom(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function structTo(struct: JsonObject | undefined): Record<string, unknown> {
  return struct ?? {};
}

const STATUS_TO_PROTO: Record<string, InstanceStatus> = {
  pending: InstanceStatus.PENDING,
  running: InstanceStatus.RUNNING,
  completed: InstanceStatus.COMPLETED,
  failed: InstanceStatus.FAILED,
};

interface DefinitionRow {
  id: string;
  name: string;
  version: number;
  createdAt: Date;
}

interface InstanceRow {
  id: string;
  definitionId: string;
  status: string;
  variables: unknown;
  startedAt: Date;
  completedAt: Date | null;
  error: string | null;
}

function definitionMessage(row: DefinitionRow) {
  return create(ProcessDefinitionSchema, {
    id: row.id,
    name: row.name,
    version: row.version,
    createdAt: timestampFromDate(row.createdAt),
  });
}

function instanceMessage(row: InstanceRow) {
  return create(ProcessInstanceSchema, {
    id: row.id,
    definitionId: row.definitionId,
    status: STATUS_TO_PROTO[row.status] ?? InstanceStatus.UNSPECIFIED,
    variables: structFrom(row.variables),
    startedAt: timestampFromDate(row.startedAt),
    ...(row.completedAt === null
      ? {}
      : { completedAt: timestampFromDate(row.completedAt) }),
    ...(row.error === null ? {} : { error: row.error }),
  });
}

export function processRoutes(engine: ProcessEngine) {
  return (router: ConnectRouter): void => {
    router.service(ProcessService, {
      async deployDefinition(req) {
        try {
          const definition = await engine.deploy(req.name, req.source);
          return { definition: definitionMessage(definition) };
        } catch (cause) {
          throw toConnectError(cause);
        }
      },

      async listDefinitions(req) {
        const pageSize =
          req.pageSize > 0 ? Math.min(req.pageSize, MAX_PAGE_SIZE) : 25;
        const skip = req.pageToken === "" ? 0 : Number.parseInt(req.pageToken, 10);
        if (!Number.isInteger(skip) || skip < 0) {
          throw new ConnectError("malformed page_token", Code.InvalidArgument);
        }

        // Over-fetch by one to learn whether another page exists.
        const rows = await engine.listDefinitions(pageSize + 1, skip);
        const page = rows.slice(0, pageSize);
        return {
          definitions: page.map(definitionMessage),
          nextPageToken:
            rows.length > pageSize ? String(skip + pageSize) : "",
        };
      },

      async startInstance(req) {
        try {
          const instance = await engine.startByIdOrName(
            req.definitionIdOrName,
            structTo(req.variables),
          );
          return { instance: instanceMessage(instance) };
        } catch (cause) {
          throw toConnectError(cause);
        }
      },

      async getInstance(req) {
        try {
          return { instance: instanceMessage(await engine.getInstance(req.id)) };
        } catch (cause) {
          throw toConnectError(cause);
        }
      },

      async signalInstance(req) {
        try {
          const instance = await engine.signal(
            req.id,
            req.elementId,
            structTo(req.payload),
          );
          return { instance: instanceMessage(instance) };
        } catch (cause) {
          throw toConnectError(cause);
        }
      },

      async *watchInstance(req, context) {
        try {
          await engine.getInstance(req.id);
        } catch (cause) {
          throw toConnectError(cause);
        }
        // Replays the log from the start, then follows it.
        for await (const event of engine.events.subscribe({
          instanceId: req.id,
          signal: context.signal,
        })) {
          yield create(WatchInstanceResponseSchema, {
            event: create(ProcessEventSchema, {
              id: String(event.seq),
              instanceId: event.instanceId,
              type: event.type,
              ...(event.elementId === undefined
                ? {}
                : { elementId: event.elementId }),
              payload: structFrom(event.payload),
              createdAt: timestampFromDate(event.createdAt),
            }),
          });
        }
      },
    });
  };
}
