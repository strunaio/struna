import { createRequire } from "node:module";
import { evaluate } from "feelin";

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

/** A task's `zeebe:input`s, in order. */
export function inputMappings(extensionElements: unknown): InputMapping[] {
  const io = extensionValues(extensionElements).find((v) => v.$type === "zeebe:IoMapping");
  return (io?.inputParameters ?? [])
    .filter((input) => input.target !== undefined && input.target !== "")
    .map((input) => ({ source: input.source ?? "", target: input.target as string }));
}

/**
 * An input's value: a FEEL expression (`=a + b`, `=add.sum`) evaluated
 * against the instance's variables, or the literal text.
 */
export function inputValue(source: string, variables: Record<string, unknown>): unknown {
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
  if ((result.value === null || result.value === undefined) && result.warnings.length > 0) {
    throw new Error(
      `FEEL "${expression}": ${result.warnings.map((w: { message: string }) => w.message).join("; ")}`,
    );
  }
  return result.value;
}
