import { ScalarType, type DescField, type DescMessage, type DescService } from "@bufbuild/protobuf";
import type { RegisteredService } from "./registry.js";

/**
 * Camunda 8 element templates for registered services, so editors that read
 * `.camunda/element-templates/` (Camunda Modeler, the BPMN Modeler extension
 * for VS Code) offer each method as a ready-made service task: pick
 * "Math › Add", fill in the request, and the task shows the service's icon.
 */

export const TEMPLATE_SCHEMA =
  "https://unpkg.com/@camunda/zeebe-element-templates-json-schema/resources/schema.json";

interface TemplateProperty {
  readonly label?: string;
  readonly description?: string;
  readonly type: "Hidden" | "String" | "Text" | "Dropdown";
  readonly value?: string;
  readonly choices?: { name: string; value: string }[];
  readonly group?: string;
  /** "optional": a literal or, with a leading "=", FEEL; "required": always FEEL. */
  readonly feel?: "optional" | "required";
  /** A blank field writes no input at all. */
  readonly optional?: boolean;
  readonly binding: {
    readonly type: string;
    readonly name?: string;
    readonly property?: string;
    readonly key?: string;
    /** For a `zeebe:output` binding: the FEEL the mapping reads. */
    readonly source?: string;
  };
}

export interface ElementTemplate {
  readonly $schema: string;
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly description: string;
  readonly category: { readonly id: string; readonly name: string };
  readonly appliesTo: string[];
  readonly elementType: { readonly value: string };
  readonly icon: { readonly contents: string };
  readonly groups: { id: string; label: string }[];
  readonly properties: TemplateProperty[];
}

/** Well-known types given as one JSON (or FEEL context) value, not nested fields. */
const JSON_STRINGS = new Set(["google.protobuf.Timestamp", "google.protobuf.Duration", "google.protobuf.FieldMask"]);

/** How deep nested messages are flattened into dotted fields. */
const MAX_DEPTH = 3;

/** "SendMessage" → "Send message". */
function humanize(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/** A field's label, as connectors word them: "recipient.email_address" → "Recipient › Email address". */
function fieldLabel(path: string): string {
  return path.split(".").map(humanize).join(" › ");
}

function typeName(field: DescField): string {
  switch (field.fieldKind) {
    case "scalar":
      return ScalarType[field.scalar].toLowerCase();
    case "enum":
      return field.enum.typeName;
    case "message":
      return field.message.typeName;
    case "list":
      return `list of ${field.listKind === "scalar" ? ScalarType[field.scalar].toLowerCase() : field.listKind === "enum" ? field.enum.typeName : field.message.typeName}`;
    case "map":
      return "map";
  }
}

/** One template field per request field, nested messages flattened. */
function requestFields(message: DescMessage, prefix = "", depth = 0): TemplateProperty[] {
  const out: TemplateProperty[] = [];
  for (const field of message.fields) {
    const target = `${prefix}${field.name}`;
    const binding = { type: "zeebe:input", name: target };

    if (field.fieldKind === "message" && !field.message.typeName.startsWith("google.protobuf.") && depth < MAX_DEPTH) {
      out.push(...requestFields(field.message, `${target}.`, depth + 1));
      continue;
    }

    if (field.fieldKind === "enum") {
      out.push({
        label: fieldLabel(target),
        description: `${field.enum.typeName} · ${target}`,
        type: "Dropdown",
        choices: field.enum.values.map((v) => ({ name: v.name, value: v.name })),
        value: field.enum.values[0]?.name ?? "",
        group: "request",
        binding,
      });
      continue;
    }

    const multiline =
      field.fieldKind === "list" ||
      field.fieldKind === "map" ||
      (field.fieldKind === "message" && !JSON_STRINGS.has(field.message.typeName));
    // The type and the proto name; the editor's FEEL toggle already says a
    // field may be an expression.
    out.push({
      label: fieldLabel(target),
      description: `${typeName(field)} · ${target}${multiline ? " — JSON, or a FEEL list or context" : ""}`,
      type: multiline ? "Text" : "String",
      feel: "optional",
      optional: true,
      group: "request",
      binding,
    });
  }
  return out;
}

/**
 * One optional output mapping per response field: `=quotient` → the variable
 * typed into the field. The editor matches a task's existing
 * `<zeebe:output source="=quotient" …/>` to this field by its source.
 */
function responseFields(message: DescMessage): TemplateProperty[] {
  return describeFields(message).map((field, index) => ({
    label: `Map ${field.target} to`,
    // The rule is said once, on the first field, rather than under every one.
    description:
      `${field.type} — variable name.` +
      (index === 0 ? " Only filled-in mappings leave the step; response fields left blank are not kept." : ""),
    type: "String",
    optional: true,
    group: "output",
    binding: { type: "zeebe:output", source: `=${field.target}` },
  }));
}

/** A result expression that fits the method: `={message: response.message}`. */
function exampleExpression(message: DescMessage): string {
  const first = describeFields(message)[0]?.target;
  if (first === undefined) return "={result: response}";
  const name = first.split(".").at(-1) as string;
  return `={${name}: response.${first}}`;
}

/** Templates for every unary method of one service, all with its icon. */
export function serviceTemplates(service: RegisteredService, desc: DescService): ElementTemplate[] {
  return desc.methods
    .filter((method) => method.methodKind === "unary")
    .map((method) => {
      const path = `${desc.typeName}/${method.name}`;
      return {
        $schema: TEMPLATE_SCHEMA,
        id: path,
        name: `${service.title} › ${humanize(method.name)}`,
        version: TEMPLATE_VERSION,
        description: `Calls ${path} through struna (${method.input.typeName} → ${method.output.typeName}).`,
        // Groups the service's methods together in the editor's picker.
        category: { id: desc.typeName, name: service.title },
        appliesTo: ["bpmn:Task", "bpmn:ServiceTask"],
        elementType: { value: "bpmn:ServiceTask" },
        icon: { contents: service.icon },
        groups: [
          { id: "request", label: "Request" },
          // As Camunda's connector templates name it.
          { id: "output", label: "Output mapping" },
        ],
        properties: [
          // The method struna calls, as the task's job type.
          { type: "Hidden", value: path, binding: { type: "zeebe:taskDefinition", property: "type" } },
          ...requestFields(method.input),
          // Where the response goes, as with a Camunda connector: one output
          // mapping per response field (the value is the variable to write),
          // a result variable or a result expression. Nothing mapped, nothing kept.
          ...responseFields(method.output),
          {
            label: "Result variable",
            description: `Name of the variable to store the response (${method.output.typeName}) in. With output mappings filled in, it stays in the step unless one maps it.`,
            type: "String",
            group: "output",
            binding: { type: "zeebe:taskHeader", key: "resultVariable" },
          },
          {
            label: "Result expression",
            description: `FEEL expression that maps the response into process variables, e.g. ${exampleExpression(method.output)}. With output mappings filled in, its entries stay in the step unless one maps them.`,
            type: "Text",
            feel: "required",
            group: "output",
            binding: { type: "zeebe:taskHeader", key: "resultExpression" },
          },
        ],
      };
    });
}

/** A file name for a service's templates: `struna-acme.demo.v1.MathService.json`. */
export function templateFileName(serviceName: string): string {
  return `struna-${serviceName}.json`;
}

/** The version every generated template carries (see `serviceTemplates`). */
export const TEMPLATE_VERSION = 1;

/** One `xml` attribute value, escaped. */
function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Link service tasks to their templates, the way an editor does when you pick
 * one: set `zeebe:modelerTemplate`, `…Version` and `…Icon` on each task whose
 * method is in `icons` (method path → icon). Only those opening tags change,
 * so comments and formatting survive. Returns the new XML and the tasks set.
 */
export function applyTemplates(
  xml: string,
  methods: Record<string, string>,
  icons: Record<string, string>,
): { xml: string; applied: string[] } {
  const applied: string[] = [];
  const out = xml.replace(/<((?:[\w-]+:)?serviceTask)\b([^>]*?)(\/?)>/g, (tag, name: string, attrs: string, selfClose: string) => {
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    const method = id === undefined ? undefined : methods[id];
    const icon = method === undefined ? undefined : icons[method];
    if (id === undefined || method === undefined || icon === undefined) return tag;
    const kept = attrs.replace(/\s+zeebe:modelerTemplate(?:Version|Icon)?="[^"]*"/g, "");
    applied.push(id);
    return (
      `<${name}${kept} zeebe:modelerTemplate="${attr(method)}"` +
      ` zeebe:modelerTemplateVersion="${TEMPLATE_VERSION}" zeebe:modelerTemplateIcon="${attr(icon)}"${selfClose}>`
    );
  });
  return { xml: out, applied };
}

/** A request field as a service task fills it in. */
export interface FieldInfo {
  /** The `zeebe:input` target: dotted for nested fields. */
  readonly target: string;
  readonly type: string;
  /** Given as one JSON value (lists, maps, Struct…) rather than a scalar. */
  readonly json: boolean;
  /** An enum's values. */
  readonly choices?: string[];
}

/** The fields of a request, flattened the way the templates flatten them. */
export function describeFields(message: DescMessage, prefix = "", depth = 0): FieldInfo[] {
  const out: FieldInfo[] = [];
  for (const field of message.fields) {
    const target = `${prefix}${field.name}`;
    if (field.fieldKind === "message" && !field.message.typeName.startsWith("google.protobuf.") && depth < MAX_DEPTH) {
      out.push(...describeFields(field.message, `${target}.`, depth + 1));
      continue;
    }
    const json =
      field.fieldKind === "list" ||
      field.fieldKind === "map" ||
      (field.fieldKind === "message" && !JSON_STRINGS.has(field.message.typeName));
    out.push({
      target,
      type: typeName(field),
      json,
      ...(field.fieldKind === "enum" ? { choices: field.enum.values.map((v) => v.name) } : {}),
    });
  }
  return out;
}
