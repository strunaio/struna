import { readFileSync } from "node:fs";

/**
 * struna's version. Releases are versioned by their git tag (release-drafter),
 * not by a version committed to package.json: a release build stamps the tag
 * into package.json (`npm pkg set version=…`); anything else is a dev build.
 * package.json sits one level above this module in both src/ and dist/.
 */
export const VERSION =
  (
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    }
  ).version ?? "0.0.0-dev";
