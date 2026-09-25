/**
 * A demo Connect service for trying service tasks: acme.demo.v1.MathService
 * and GreeterService from examples/services/proto, implemented without
 * generated code from the same descriptor set struna registers.
 *
 *   npm run demo:services            # serves on http://localhost:9000
 *   npx struna services add --descriptor examples/services/demo.binpb --url http://localhost:9000
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { ServiceRegistry } from "../../src/engine/registry.js";

const PORT = Number(process.env["PORT"] ?? 9000);
const DESCRIPTOR = "examples/services/demo.binpb";

// The descriptor set struna needs, rebuilt from the proto on every start.
execFileSync("npx", ["--no-install", "buf", "build", "examples/services/proto", "-o", DESCRIPTOR], {
  stdio: "inherit",
});
const types = ServiceRegistry.parse(readFileSync(DESCRIPTOR));
const math = types.getService("acme.demo.v1.MathService")!;
const greeter = types.getService("acme.demo.v1.GreeterService")!;

const log = (method: string, context: { requestHeader: Headers }, detail: unknown) =>
  process.stdout.write(
    `${new Date().toISOString().slice(11, 19)} ${method} ${JSON.stringify(detail, (key, value: unknown) =>
      key === "$typeName" ? undefined : value,
    )}` +
      ` (instance ${context.requestHeader.get("struna-instance-id") ?? "-"},` +
      ` step ${context.requestHeader.get("struna-element-id") ?? "-"})\n`,
  );

const routes = (router: ConnectRouter): void => {
  router.service(math, {
    add(req: { a: number; b: number }, context: { requestHeader: Headers }) {
      log("MathService/Add", context, req);
      return { sum: req.a + req.b };
    },
    divide(req: { a: number; b: number }, context: { requestHeader: Headers }) {
      log("MathService/Divide", context, req);
      if (req.b === 0) throw new ConnectError("cannot divide by zero", Code.InvalidArgument);
      return { quotient: req.a / req.b };
    },
  } as never);
  router.service(greeter, {
    greet(req: { name: string; locale: string }, context: { requestHeader: Headers }) {
      log("GreeterService/Greet", context, req);
      const hello = { de: "Hallo", fr: "Bonjour", uk: "Привіт", es: "Hola" }[req.locale] ?? "Hello";
      return { message: `${hello}, ${req.name}!` };
    },
    echo(req: unknown, context: { requestHeader: Headers }) {
      log("GreeterService/Echo", context, req);
      return { request: req };
    },
  } as never);
};

http.createServer(connectNodeAdapter({ routes })).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(
    `demo services on http://localhost:${PORT}\n` +
      `register them: npx struna services add --descriptor ${DESCRIPTOR} --url http://localhost:${PORT}\n`,
  );
});
