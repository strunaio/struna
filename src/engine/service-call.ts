import {
  fromJson,
  toJson,
  ScalarType,
  type DescField,
  type DescMessage,
  type JsonValue,
} from "@bufbuild/protobuf";
import { ConnectError, createClient, type Transport } from "@connectrpc/connect";
import {
  createConnectTransport,
  createGrpcTransport,
  createGrpcWebTransport,
} from "@connectrpc/connect-node";
import { findField, type ResolvedMethod } from "./registry.js";

/** Kept under the worker's 30s run limit, so a hung call fails the step cleanly. */
const DEFAULT_TIMEOUT_MS = 25_000;

export interface CallContext {
  readonly instanceId: string;
  readonly elementId: string;
}

function transportFor(resolved: ResolvedMethod): Transport {
  const baseUrl = resolved.baseUrl;
  switch (resolved.protocol) {
    case "grpc":
      return createGrpcTransport({ baseUrl });
    case "grpcweb":
      return createGrpcWebTransport({ baseUrl, httpVersion: "1.1" });
    default:
      return createConnectTransport({ baseUrl, httpVersion: "1.1" });
  }
}

/**
 * A text value from the BPMN, as the JSON the field expects. Input parameters
 * are strings unless an expression produced something else; a string field
 * keeps them as they are, any other field parses them as JSON (`42`, `true`,
 * `["a","b"]`, `{"k":1}`), falling back to the text so the error names it.
 */
function coerce(field: DescField | undefined, value: unknown): unknown {
  if (typeof value !== "string" || field === undefined) return value;
  if (field.fieldKind === "enum") return value;
  if (field.fieldKind === "scalar" && (field.scalar === ScalarType.STRING || field.scalar === ScalarType.BYTES)) {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/**
 * The request as proto JSON from a service task's input parameters. A dotted
 * name sets a nested field: `recipient.email_address`.
 */
export function buildRequest(input: DescMessage, params: Record<string, unknown>): Record<string, unknown> {
  const request: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(params)) {
    // Editors create an input for every template field, filled in or not; a
    // blank one means "leave the field at its default".
    if (value === undefined || value === "") continue;
    const path = name.split(".");
    let target = request;
    let message: DescMessage | undefined = input;
    path.forEach((segment, i) => {
      const field: DescField | undefined = message === undefined ? undefined : findField(message, segment);
      if (i === path.length - 1) {
        target[segment] = coerce(field, value);
        return;
      }
      const next = (target[segment] ??= {}) as Record<string, unknown>;
      target = next;
      message = field?.fieldKind === "message" ? field.message : undefined;
    });
  }
  return request;
}

/**
 * Call one unary method with a service task's inputs and return the response
 * as JSON — the task's result. Failures name the method.
 */
export async function callMethod(
  resolved: ResolvedMethod,
  params: Record<string, unknown>,
  context: CallContext,
  options: { readonly timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const { method, service, path } = resolved;
  let request;
  try {
    request = fromJson(method.input, buildRequest(method.input, params) as JsonValue);
  } catch (cause) {
    throw new Error(
      `${path}: the inputs do not make a valid ${method.input.typeName}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

  const client = createClient(service, transportFor(resolved)) as unknown as Record<
    string,
    (request: unknown, options: object) => Promise<unknown>
  >;
  try {
    const response = await client[method.localName]!(request, {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      headers: {
        // Lets the service tie the call to the run, and deduplicate retries.
        "struna-instance-id": context.instanceId,
        "struna-element-id": context.elementId,
      },
    });
    return toJson(method.output, response as never) as Record<string, unknown>;
  } catch (cause) {
    const error = ConnectError.from(cause);
    throw new Error(`${path} failed: ${error.message}`, { cause: error });
  }
}
