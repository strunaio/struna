import { BpmnModdle } from "bpmn-moddle";
import { inputMappings, methodOf, moddleOptions } from "../engine/bpmn-extensions.js";
import { zeebeScript } from "../engine/feel-scripts.js";

/** What the BPMN says about one element: the static half of the inspector. */
export interface ElementDefinition {
  readonly id: string;
  readonly type: string;
  readonly name: string | undefined;
  readonly documentation: string[];
  readonly script: Expression | undefined;
  /** For a service task: the Connect/gRPC method it calls, and its inputs. */
  readonly call: { readonly method: string; readonly inputs: [string, string][] } | undefined;
  /** For a sequence flow: its own condition, ends, and whether it is the default. */
  readonly flow: FlowInfo | undefined;
  /** Where the element can go next — the interesting part of a gateway. */
  readonly outgoing: FlowInfo[];
  /** Timer, message, signal, error… definitions of an event. */
  readonly events: Detail[];
  /** Loop or multi-instance settings. */
  readonly loop: Detail | undefined;
  /** Core settings worth showing (implementation, calledElement, …). */
  readonly properties: [string, string][];
  /** Extension attributes, e.g. `zeebe:modelerTemplate`. */
  readonly attributes: [string, string][];
}

export interface Expression {
  readonly language: string | undefined;
  readonly body: string;
}

export interface FlowInfo {
  readonly id: string;
  readonly name: string | undefined;
  readonly source: Ref;
  readonly target: Ref;
  readonly condition: Expression | undefined;
  readonly isDefault: boolean;
}

export interface Ref {
  readonly id: string;
  readonly name: string | undefined;
}

export interface Detail {
  readonly type: string;
  readonly fields: [string, string][];
}

/** The moddle object graph, loosely: every element is a bag of properties. */
interface Node {
  readonly $type: string;
  readonly $parent?: Node;
  readonly $attrs?: Record<string, string>;
  readonly id?: string;
  readonly name?: string;
  readonly [key: string]: unknown;
}

/** Core attributes shown under "Settings" when an element sets them. */
const PROPERTIES = [
  "implementation",
  "calledElement",
  "attachedToRef",
  "cancelActivity",
  "instantiate",
  "messageRef",
  "gatewayDirection",
  "eventGatewayType",
  "triggeredByEvent",
  "isForCompensation",
  "startQuantity",
  "completionQuantity",
];

/**
 * Values bpmn-moddle reports even when the XML never set them; showing them
 * would bury what the author actually configured.
 */
const MODEL_DEFAULTS: Record<string, string> = {
  gatewayDirection: "Unspecified",
  eventGatewayType: "Exclusive",
  cancelActivity: "true",
  instantiate: "false",
  triggeredByEvent: "false",
  isForCompensation: "false",
  startQuantity: "1",
  completionQuantity: "1",
};

/** Definitions are immutable per id, so a parsed model never goes stale. */
const models = new Map<string, Promise<Record<string, Node>>>();

function parse(definitionId: string, source: string): Promise<Record<string, Node>> {
  let model = models.get(definitionId);
  if (model === undefined) {
    model = new BpmnModdle(moddleOptions)
      .fromXML(source)
      .then((result) => result.elementsById as unknown as Record<string, Node>);
    model.catch(() => models.delete(definitionId));
    models.set(definitionId, model);
  }
  return model;
}

const bare = (type: string): string => type.replace(/^bpmn:/, "");

function ref(node: unknown): Ref {
  const n = node as Node | undefined;
  return { id: n?.id ?? "?", name: n?.name };
}

function expression(node: unknown): Expression | undefined {
  const n = node as (Node & { body?: string; language?: string }) | undefined;
  if (n?.body === undefined || n.body.trim() === "") return undefined;
  return { language: n.language, body: n.body.trim() };
}

/** Plain values of a node's own properties, for the "details" lists. */
function fields(node: Node): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$") || key === "id") continue;
    const expr = expression(value);
    if (expr !== undefined) out.push([key, expr.body]);
    else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out.push([key, String(value)]);
    } else if (value && typeof value === "object" && "id" in value) {
      const target = value as Node;
      out.push([key, target.name ? `${target.name} (${target.id})` : String(target.id)]);
    }
  }
  return out;
}

function flowInfo(flow: Node): FlowInfo {
  const source = flow["sourceRef"] as Node | undefined;
  return {
    id: flow.id ?? "?",
    name: flow.name,
    source: ref(source),
    target: ref(flow["targetRef"]),
    condition: expression(flow["conditionExpression"]),
    isDefault: (source?.["default"] as Node | undefined)?.id === flow.id,
  };
}

/**
 * Describe `elementId` in the definition's BPMN, or undefined when the
 * diagram has no such element (e.g. a label or the canvas root was clicked).
 */
export async function describeElement(
  definitionId: string,
  source: string,
  elementId: string,
): Promise<ElementDefinition | undefined> {
  const byId = await parse(definitionId, source);
  const node = byId[elementId];
  if (node === undefined) return undefined;

  // Hand-written BPMN often omits <outgoing>; the flows' sourceRef is the truth.
  const siblings = (node.$parent?.["flowElements"] as Node[] | undefined) ?? [];
  const outgoing = siblings
    .filter((el) => el.$type === "bpmn:SequenceFlow" && (el["sourceRef"] as Node | undefined)?.id === elementId)
    .map(flowInfo);

  const documentation = ((node["documentation"] as { text?: string }[] | undefined) ?? [])
    .map((doc) => doc.text?.trim() ?? "")
    .filter((text) => text !== "");

  const feelScript = zeebeScript(node["extensionElements"]);
  const script =
    feelScript !== undefined
      ? {
          language: `FEEL → ${feelScript.resultVariable ?? "?"}`,
          body: feelScript.expression,
        }
      : typeof node["script"] === "string" && node["script"].trim() !== ""
        ? { language: node["scriptFormat"] as string | undefined, body: node["script"].trim() }
        : undefined;

  const method = methodOf(node as { method?: unknown; extensionElements?: unknown });
  const call =
    method === undefined
      ? undefined
      : {
          method,
          inputs: inputMappings(node["extensionElements"]).map(
            (input): [string, string] => [input.target, input.source],
          ),
        };

  const events = ((node["eventDefinitions"] as Node[] | undefined) ?? []).map((def) => ({
    type: bare(def.$type),
    fields: fields(def),
  }));

  const loopNode = node["loopCharacteristics"] as Node | undefined;
  const loop = loopNode === undefined ? undefined : { type: bare(loopNode.$type), fields: fields(loopNode) };

  const properties: [string, string][] = [];
  for (const key of PROPERTIES) {
    const value = node[key];
    if (value === undefined || value === null || value === "") continue;
    const shown = typeof value === "object" ? ref(value).id : String(value);
    if (MODEL_DEFAULTS[key] === shown) continue;
    properties.push([key, shown]);
  }

  const attributes = Object.entries(node.$attrs ?? {}).filter(
    ([key]) => key !== "xmlns" && !key.startsWith("xmlns:"),
  );
  // Extension properties moddle knows the schema of (zeebe:modelerTemplate, …)
  // are typed properties, not $attrs; list the ones the XML sets. Own
  // properties only: a schema default was never written by the author.
  const descriptor = (
    node as {
      $descriptor?: { properties?: { name: string; ns?: { name?: string; prefix?: string; localName?: string } }[] };
    }
  ).$descriptor;
  for (const prop of descriptor?.properties ?? []) {
    const prefix = prop.ns?.prefix;
    const qualified = prop.ns?.name ?? prop.name;
    // The template icon is a long data: URI; the diagram already shows it.
    if (prefix === undefined || prefix === "bpmn" || qualified === "zeebe:modelerTemplateIcon") continue;
    const local = prop.ns?.localName ?? prop.name;
    if (!Object.prototype.hasOwnProperty.call(node, local)) continue;
    const value = node[local];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      attributes.push([qualified, String(value)]);
    }
  }

  return {
    id: elementId,
    type: bare(node.$type),
    name: node.name,
    documentation,
    script,
    call,
    flow: node.$type === "bpmn:SequenceFlow" ? flowInfo(node) : undefined,
    outgoing,
    events,
    loop,
    properties,
    attributes,
  };
}

/** Every service task of a definition and the method it calls, by element id. */
export async function serviceTaskMethods(definitionId: string, source: string): Promise<Record<string, string>> {
  const byId = await parse(definitionId, source);
  const methods: Record<string, string> = {};
  for (const [id, node] of Object.entries(byId)) {
    if (node.$type !== "bpmn:ServiceTask") continue;
    const method = methodOf(node as { method?: unknown; extensionElements?: unknown });
    if (method !== undefined) methods[id] = method;
  }
  return methods;
}
