import { createRequire } from "node:module";
import { evaluate } from "feelin";
import { zeebeScript } from "./feel-scripts.js";

const require = createRequire(import.meta.url);

/**
 * Camunda 8's moddle schema: `zeebe:taskDefinition`, `zeebe:ioMapping`,
 * `zeebe:modelerTemplateIcon` and friends. struna reads BPMN the Zeebe way, so
 * Camunda 8 editors (Camunda Modeler, the BPMN Modeler extension for VS Code)
 * edit what struna runs, element templates and their icons included.
 */
const zeebe = require("zeebe-bpmn-moddle/resources/zeebe.json") as object;

/** Moddle extensions every BPMN parse in struna uses: engine, deploy checks, inspector. */
export const moddleOptions = { zeebe };

/** One `zeebe:input` of a task's `zeebe:ioMapping`. */
export interface InputMapping {
  /** A FEEL expression when it starts with "=", otherwise a literal. */
  readonly source: string;
  /** The request field it sets; dots reach nested fields. */
  readonly target: string;
}

interface ExtensionValue {
  readonly $type: string;
  readonly type?: string;
  readonly inputParameters?: { source?: string; target?: string }[];
  readonly outputParameters?: { source?: string; target?: string }[];
  readonly values?: { key?: string; value?: string }[];
}

function extensionValues(extensionElements: unknown): ExtensionValue[] {
  return (extensionElements as { values?: ExtensionValue[] } | undefined)?.values ?? [];
}

/** The method a service task calls: its `zeebe:taskDefinition` type. */
export function methodOf(element: { extensionElements?: unknown }): string | undefined {
  const definition = extensionValues(element.extensionElements).find((v) => v.$type === "zeebe:TaskDefinition");
  const type = definition?.type?.trim();
  return type === undefined || type === "" ? undefined : type;
}

function mappings(extensionElements: unknown, kind: "inputParameters" | "outputParameters"): InputMapping[] {
  const io = extensionValues(extensionElements).find((v) => v.$type === "zeebe:IoMapping");
  return (io?.[kind] ?? [])
    .filter((mapping) => mapping.target !== undefined && mapping.target !== "")
    .map((mapping) => ({ source: mapping.source ?? "", target: mapping.target as string }));
}

/** A task's `zeebe:input`s, in order. */
export function inputMappings(extensionElements: unknown): InputMapping[] {
  return mappings(extensionElements, "inputParameters");
}

/** A task's `zeebe:output`s, in order. */
export function outputMappings(extensionElements: unknown): InputMapping[] {
  return mappings(extensionElements, "outputParameters");
}

/** A task's `zeebe:taskHeaders`, as key → value. */
export function taskHeaders(extensionElements: unknown): Record<string, string> {
  const headers = extensionValues(extensionElements).find((v) => v.$type === "zeebe:TaskHeaders");
  return Object.fromEntries(
    (headers?.values ?? [])
      .filter((header) => header.key !== undefined && header.key !== "")
      .map((header) => [header.key as string, header.value ?? ""]),
  );
}

/**
 * An input's value: a FEEL expression (`=a + b`, `=add.sum`) evaluated
 * against the instance's variables, or the literal text. Strict (the default,
 * for requests) turns a missing variable into an error; lenient (outputs)
 * lets it be null, as Camunda 8 does.
 */
export function inputValue(
  source: string,
  variables: Record<string, unknown>,
  options: { readonly strict?: boolean } = {},
): unknown {
  if (!source.startsWith("=")) return source;
  const expression = source.slice(1);
  let result;
  try {
    result = evaluate(expression, variables);
  } catch (cause) {
    throw new Error(`FEEL "${expression}": ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  // A missing variable evaluates to null with a warning; say which, rather
  // than sending an empty field.
  if (options.strict !== false && (result.value === null || result.value === undefined) && result.warnings.length > 0) {
    throw new Error(
      `FEEL "${expression}": ${result.warnings.map((w: { message: string }) => w.message).join("; ")}`,
    );
  }
  return result.value ?? null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Set `a.b.c` in `target`, creating the objects on the way. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (!isObject(node[key])) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys.at(-1) as string] = value;
}

/** How one task's result reaches the process variables. */
export interface ResultRules {
  /** `zeebe:output`s: only what they map is written. */
  readonly outputs: readonly InputMapping[];
  /** Task header `resultVariable`: the whole result under this name. */
  readonly resultVariable?: string | undefined;
  /** Task header `resultExpression`: FEEL over `response`; a context's entries become variables. */
  readonly resultExpression?: string | undefined;
  /** The step's input values (its local variables), visible to its output mappings. */
  readonly locals?: Record<string, unknown> | undefined;
  /**
   * What happens to a result nothing maps: "merge" its fields by name (job
   * workers, user tasks, messages) or "discard" it (connectors — struna's
   * service tasks, which call an API on the process's behalf).
   */
  readonly unmapped?: "merge" | "discard";
}

/** The rules a task's BPMN sets for its result. */
export function resultRules(
  extensionElements: unknown,
  locals?: Record<string, unknown>,
  unmapped: "merge" | "discard" = "merge",
): ResultRules {
  const headers = taskHeaders(extensionElements);
  return {
    unmapped,
    outputs: outputMappings(extensionElements),
    // A zeebe:script names its own result variable.
    resultVariable: headers["resultVariable"] || zeebeScript(extensionElements)?.resultVariable || undefined,
    resultExpression: headers["resultExpression"] || undefined,
    locals,
  };
}

/**
 * How a value reached the variables: an output mapping or a result
 * expression someone wrote, or a rule nobody wrote an expression for — a
 * field merged by name, or the whole result under a resultVariable.
 */
export type MappingKind = "mapping" | "expression" | "merged" | "whole" | "local";

/** One variable a task set: where it went, how, from what, and the value. */
export interface MappedValue {
  readonly target: string;
  /** "local": produced inside the step but not propagated (output mappings decide). */
  readonly kind: MappingKind;
  /** The FEEL or literal as written; empty for "merged" and "whole". */
  readonly source: string;
  readonly value: unknown;
}

/**
 * Apply a task's result — a service's response, a signal's payload, a
 * script's value — to the process variables with Zeebe's propagation rule.
 *
 * The step's own variables are the result's fields plus what
 * `resultVariable` / `resultExpression` produce. With output mappings, those
 * stay inside the step and only the mappings' targets propagate (the
 * mappings read the step's variables, its inputs and the process). Without
 * them, what `resultVariable` / `resultExpression` produce propagates; with
 * neither, the result's fields merge by name — unless the task discards
 * unmapped results, as connectors (struna's service tasks) do.
 *
 * Returns what was written and how, plus what stayed inside the step.
 */
export function applyResult(
  variables: Record<string, unknown>,
  result: unknown,
  rules: ResultRules,
): MappedValue[] {
  const written: MappedValue[] = [];
  const write = (target: string, kind: MappingKind, source: string, value: unknown) => {
    setPath(variables, target, value);
    written.push({ target, kind, source, value });
  };

  // What resultVariable / resultExpression produce: variables of the step.
  const produced: MappedValue[] = [];
  if (rules.resultVariable !== undefined) {
    produced.push({ target: rules.resultVariable, kind: "whole", source: "", value: result });
  }
  if (rules.resultExpression !== undefined) {
    const shaped = inputValue(rules.resultExpression, { ...variables, response: result }, { strict: false });
    if (isObject(shaped)) {
      for (const [key, value] of Object.entries(shaped)) {
        produced.push({ target: key, kind: "expression", source: rules.resultExpression, value });
      }
    }
  }

  if (rules.outputs.length > 0) {
    const step: Record<string, unknown> = { ...(isObject(result) ? result : {}) };
    for (const p of produced) setPath(step, p.target, p.value);
    // What an output mapping sees: the process, the step's inputs, then its own variables.
    const scope = { ...variables, ...(rules.locals ?? {}), ...step };
    for (const output of rules.outputs) {
      write(output.target, "mapping", output.source, inputValue(output.source, scope, { strict: false }));
    }
    // Produced but not mapped: it stays in the step, as in Zeebe.
    for (const p of produced) written.push({ ...p, kind: "local" });
    return written;
  }

  if (produced.length > 0) {
    for (const p of produced) write(p.target, p.kind, p.source, p.value);
  } else if (rules.unmapped !== "discard" && isObject(result)) {
    for (const [key, value] of Object.entries(result)) write(key, "merged", "", value);
  }
  return written;
}
