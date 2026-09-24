#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { serveCommand } from "./commands/serve.js";
import { workerCommand } from "./commands/worker.js";

// Releases are versioned by their git tag (release-drafter), not by a version
// committed to package.json. A release build stamps the tag into package.json
// (`npm pkg set version=…`); anything else is a development build.
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version?: string };

const program = new Command()
  .name("struna")
  .description("BPMN-driven process server with a Connect RPC API")
  .version(pkg.version ?? "0.0.0-dev")
  .addCommand(serveCommand())
  .addCommand(workerCommand());

await program.parseAsync(process.argv);
