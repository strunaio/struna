#!/usr/bin/env node
import { Command } from "commander";
import { serveCommand } from "./commands/serve.js";
import { workerCommand } from "./commands/worker.js";
import { VERSION } from "./version.js";

const program = new Command()
  .name("struna")
  .description("BPMN-driven process server with a Connect RPC API")
  .version(VERSION)
  .addCommand(serveCommand())
  .addCommand(workerCommand());

await program.parseAsync(process.argv);
