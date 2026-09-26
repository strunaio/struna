import { JavaScripts } from "bpmn-engine";
import { evaluate } from "feelin";

/** A Camunda 8 script task's `zeebe:script`. */
export interface ZeebeScript {
  readonly expression: string;
  readonly resultVariable?: string | undefined;
}

/** The `zeebe:script` of an element's extension elements, if it has one. */
export function zeebeScript(extensionElements: unknown): ZeebeScript | undefined {
  const values =
    (extensionElements as { values?: { $type: string; expression?: string; resultVariable?: string }[] } | undefined)
      ?.values ?? [];
  const script = values.find((value) => value.$type === "zeebe:Script");
  if (script?.expression === undefined || script.expression.trim() === "") return undefined;
  return { expression: script.expression.trim(), resultVariable: script.resultVariable || undefined };
}

/** A condition written the Camunda 8 way: FEEL, `=…`, with no other language. */
function feelCondition(behaviour: { conditionExpression?: { body?: string; language?: string } }): string | undefined {
  const condition = behaviour.conditionExpression;
  const body = condition?.body?.trim();
  if (body === undefined || !body.startsWith("=")) return undefined;
  if (condition?.language !== undefined && condition.language.toLowerCase() !== "feel") return undefined;
  return body;
}

interface Registrant {
  readonly id: string;
  readonly type: string;
  readonly behaviour: {
    conditionExpression?: { body?: string; language?: string };
    extensionElements?: unknown;
  };
}

interface ExecutionScope {
  readonly environment: { readonly variables: Record<string, unknown> };
}

type Callback = (error: unknown, result?: unknown) => void;

/**
 * bpmn-engine's script registry, with FEEL. Sequence-flow conditions written
 * `=…` and script tasks with a `zeebe:script` are evaluated as FEEL over the
 * instance's variables, as Camunda 8 does; everything else (JavaScript) goes
 * to bpmn-engine's own runner, as before.
 */
export class FeelScripts {
  readonly #feel = new Map<string, { readonly expression: string; readonly condition: boolean }>();
  readonly #javascript = new JavaScripts();

  register(registrant: Registrant): unknown {
    if (registrant.type === "bpmn:SequenceFlow") {
      const expression = feelCondition(registrant.behaviour);
      if (expression !== undefined) {
        this.#feel.set(registrant.id, { expression: expression.slice(1), condition: true });
        return undefined;
      }
    }
    if (registrant.type === "bpmn:ScriptTask") {
      const script = zeebeScript(registrant.behaviour.extensionElements);
      if (script !== undefined) {
        const expression = script.expression.startsWith("=") ? script.expression.slice(1) : script.expression;
        this.#feel.set(registrant.id, { expression, condition: false });
        return undefined;
      }
    }
    return (this.#javascript as unknown as { register(r: Registrant): unknown }).register(registrant);
  }

  getScript(language: string | undefined, identifier: { id: string }): unknown {
    const feel = this.#feel.get(identifier.id);
    if (feel === undefined) {
      return (this.#javascript as unknown as { getScript(l: string | undefined, i: { id: string }): unknown }).getScript(
        language,
        identifier,
      );
    }
    return {
      execute(scope: ExecutionScope, callback: Callback) {
        let value: unknown;
        try {
          value = evaluate(feel.expression, scope.environment.variables).value;
        } catch (cause) {
          callback(new Error(`FEEL "${feel.expression}": ${cause instanceof Error ? cause.message : String(cause)}`));
          return;
        }
        // A condition is taken only when it is true; null (a missing name) is not.
        callback(null, feel.condition ? value === true : (value ?? null));
      },
    };
  }
}
