import { readFileSync } from "node:fs";
import path from "node:path";
import { ProcessError } from "./errors.js";

/** Icons travel inside every element template and diagram; keep them small. */
const MAX_ICON_BYTES = 64 * 1024;

const MIME: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** An SVG or PNG file as the data: URI editors and the dashboard use. */
export function iconFromFile(file: string): string {
  const mime = MIME[path.extname(file).toLowerCase()];
  if (mime === undefined) {
    throw new ProcessError(`an icon must be an .svg or .png file, got ${file}`, "invalid_argument");
  }
  const content = readFileSync(file);
  if (content.length > MAX_ICON_BYTES) {
    throw new ProcessError(
      `icon ${file} is ${content.length} bytes; keep it under ${MAX_ICON_BYTES}`,
      "invalid_argument",
    );
  }
  return `data:${mime};base64,${content.toString("base64")}`;
}

/** Accept an icon given as a data: URI (the RPC's form), or refuse it. */
export function checkIcon(icon: string): string {
  if (!/^data:image\/(svg\+xml|png)(;base64)?,/.test(icon)) {
    throw new ProcessError("an icon must be a data:image/svg+xml or data:image/png URI", "invalid_argument");
  }
  if (icon.length > MAX_ICON_BYTES * 1.4) {
    throw new ProcessError(`the icon is too large; keep it under ${MAX_ICON_BYTES} bytes`, "invalid_argument");
  }
  return icon;
}

/** `acme.slack.v1.ChatService` → "Chat"; `acme.demo.v1.Math` → "Math". */
export function defaultTitle(serviceName: string): string {
  const short = serviceName.slice(serviceName.lastIndexOf(".") + 1);
  const bare = short.replace(/Service$/, "") || short;
  // Split camel case: "UserProfiles" → "User Profiles".
  return bare.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/**
 * A default icon: the title's initial on a tile whose colour is derived from
 * the service name, so two services rarely look alike.
 */
export function monogramIcon(serviceName: string): string {
  let hash = 0;
  for (const char of serviceName) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const letter = (defaultTitle(serviceName)[0] ?? "?").toUpperCase();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="hsl(${hue} 55% 42%)"/>` +
    `<text x="16" y="22" text-anchor="middle" font-family="system-ui,sans-serif" font-size="17" font-weight="700" fill="#fff">${letter}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
