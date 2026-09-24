import path from "node:path";
import { fileURLToPath } from "node:url";
import { Eta } from "eta";

// Templates are read from src/views in both modes: this module sits at
// src/server/ under tsx and dist/server/ once built, two levels below the
// package root either way, so tsc does not need to copy them.
const viewsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/views",
);

/**
 * Eta caches compiled templates; disable that in development so edits to
 * .eta files show up without a restart.
 */
export const eta = new Eta({
  views: viewsDir,
  cache: process.env["NODE_ENV"] === "production",
  autoEscape: true,
});

export function render(template: string, data: Record<string, unknown>): string {
  return eta.render(template, data);
}
