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
  /** Lets the field hold a literal or, with a leading "=", FEEL. */
  readonly feel?: "optional";
  /** A blank field writes no input at all. */
  readonly optional?: boolean;
  readonly binding: { readonly type: string; readonly name?: string; readonly property?: string };
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

const HINT = 'A value, or FEEL starting with "=" (e.g. =order.total).';

/** "SendMessage" → "Send message". */
function humanize(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
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
        label: target,
        description: field.enum.typeName,
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
    out.push({
      label: target,
      description: `${typeName(field)}. ${multiline ? "A JSON value or a FEEL list/context. " : ""}${HINT}`,
      type: multiline ? "Text" : "String",
      feel: "optional",
      optional: true,
      group: "request",
      binding,
    });
  }
  return out;
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
        groups: [{ id: "request", label: "Request" }],
        properties: [
          // The method struna calls, as the task's job type.
          { type: "Hidden", value: path, binding: { type: "zeebe:taskDefinition", property: "type" } },
          ...requestFields(method.input),
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
