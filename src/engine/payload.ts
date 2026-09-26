import type { Prisma } from "../gen/prisma/client.js";

/**
 * Key fragments whose values are masked wherever struna shows or logs data:
 * a key matches when its lowercased, separator-free form contains one, so
 * `accessToken`, `refresh_token` and `X-Api-Key` all match.
 */
export const DEFAULT_REDACT_KEYS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "authorization",
  "cookie",
  "credential",
] as const;

/** Largest payload written to the event log; bigger ones are replaced. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024;

export const REDACTED = "[redacted]";

export interface PayloadPolicy {
  readonly redactKeys: readonly string[];
  readonly maxBytes: number;
}

export const DEFAULT_PAYLOAD_POLICY: PayloadPolicy = {
  redactKeys: DEFAULT_REDACT_KEYS,
  maxBytes: DEFAULT_MAX_PAYLOAD_BYTES,
};

/** Parse STRUNA_REDACT_KEYS-style input: comma-separated, blanks ignored. */
export function parseRedactKeys(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return DEFAULT_REDACT_KEYS;
  return raw
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key !== "");
}

function normalize(key: string): string {
  return key.toLowerCase().replace(/[\s_.-]/g, "");
}

/**
 * Plain JSON with sensitive values masked, at any depth. Anything that is not
 * JSON (functions, cycles, bigints) is dropped or described rather than
 * thrown on — recording must never take down a run.
 */
export function redact(value: unknown, policy: PayloadPolicy): Prisma.JsonValue {
  const fragments = policy.redactKeys.map(normalize).filter((f) => f !== "");
  let json: string | undefined;
  try {
    json = JSON.stringify(value, function (this: unknown, key, inner: unknown) {
      if (key !== "" && fragments.some((f) => normalize(key).includes(f))) {
        return REDACTED;
      }
      return typeof inner === "bigint" ? inner.toString() : inner;
    });
  } catch {
    return { unserializable: true };
  }
  return json === undefined ? null : (JSON.parse(json) as Prisma.JsonValue);
}

/** {@link redact}, then swap anything over the size cap for a marker. */
export function sanitize(value: unknown, policy: PayloadPolicy): Prisma.InputJsonValue {
  const clean = redact(value, policy);
  const bytes = Buffer.byteLength(JSON.stringify(clean));
  if (bytes > policy.maxBytes) return { truncated: true, bytes };
  // A bare null is not an InputJsonValue; the log stores "nothing" as {}.
  return (clean ?? {}) as Prisma.InputJsonValue;
}

/** Whether a key or dotted path names something to mask. */
export function isSensitiveKey(key: string, policy: PayloadPolicy): boolean {
  const fragments = policy.redactKeys.map(normalize).filter((f) => f !== "");
  return key.split(".").some((segment) => fragments.some((f) => normalize(segment).includes(f)));
}

/**
 * Mapping rows (`{target, source, value}`) with values masked where the
 * target is sensitive: masking by key alone would miss them, since the value
 * sits under "value", not under "password".
 */
export function maskMappings<T extends { target: string; value: unknown }>(rows: readonly T[], policy: PayloadPolicy): T[] {
  return rows.map((row) => (isSensitiveKey(row.target, policy) ? { ...row, value: REDACTED } : row));
}
