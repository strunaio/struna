# Editor extensions: Struna's own BPMN settings

Status: design note, not implemented. Written 2026-09-25.

Struna runs Zeebe-flavoured BPMN and relies on Camunda 8 editors for
modeling. This note records how Struna-specific settings (retries, error
handling, timeouts, …) should reach the XML and the editors.

## Direction

1. **Zeebe's own fields first.** Where Zeebe or Camunda's connector convention already has a field, Struna uses it, so the files mean the same thing to Camunda tooling and people who know it.
2. **A `struna:` extension only for what Zeebe cannot express.** It is kept in mind, not built yet.
3. **Editors:**
   - **Camunda Modeler** is the target for a plugin.
   - **VS Code (Miragon)** is optional: it gets whatever element templates can do, nothing more.

## 1. Zeebe fields (in use / next)

| Setting | Field | Origin | Struna |
| --- | --- | --- | --- |
| Method to call | `zeebe:taskDefinition type="pkg.Service/Method"` | Zeebe | in use |
| Request | `zeebe:input` | Zeebe | in use |
| Output mapping | `zeebe:output` | Zeebe | in use |
| Result | task headers `resultVariable`, `resultExpression` | connectors | in use |
| Retries | `zeebe:taskDefinition retries="3"` | Zeebe | next |
| Retry backoff | task header `retryBackoff`, ISO 8601 duration (`PT10S`) | connectors | next |
| Error handling | task header `errorExpression`, FEEL with `bpmnError(code, message)` | connectors | next |

Element templates bind these as Camunda's connector templates do:

```json
{ "label": "Retries", "type": "String", "value": "3", "group": "retries",
  "binding": { "type": "zeebe:taskDefinition", "property": "retries" } }
{ "label": "Retry backoff", "type": "String", "value": "PT0S", "group": "retries",
  "binding": { "type": "zeebe:taskHeader", "key": "retryBackoff" } }
{ "label": "Error expression", "type": "Text", "feel": "required", "group": "error",
  "binding": { "type": "zeebe:taskHeader", "key": "errorExpression" } }
```

These work in both editors without a plugin. Struna does not act on retries,
backoff and error expressions yet; see [service-calls.md](service-calls.md).
When they are implemented, the
templates gain the **Error handling** and **Retries** groups the connector
templates have (see `src/engine/templates.ts`).

## 2. A `struna:` namespace (later)

Only for settings Zeebe has no field for, or that need structure. Zeebe has no
BPMN-level job timeout, for example; the worker sets it when it takes a job.

```xml
<bpmn:extensionElements>
  <struna:call timeout="PT30S" />
</bpmn:extensionElements>
```

- **Struna:** a moddle schema `struna.json` next to Zeebe's in `moddleOptions` (`src/engine/bpmn-extensions.ts`), validated at deploy, and shown in the inspector.
- **Editors:** keep unknown extension elements on save, but cannot edit them without a plugin.
- **Fallback before a plugin exists:** a flat setting can live in `<zeebe:properties><zeebe:property name="struna.timeout" value="PT30S"/></zeebe:properties>`, which templates can bind. It is a stopgap, not the target.

## 3. Camunda Modeler plugin (later)

Camunda Modeler's plugin API can register a moddle extension
(`registerBpmnJSModdleExtension`), a bpmn-js module (`registerBpmnJSPlugin`)
and properties-panel providers. A Struna plugin would:

- edit `struna:*` elements in a **Struna** group of the properties panel;
- pick a method from the live registry (`RegistryService/ListServices`) instead of exported templates;
- validate against the registry while modeling.

VS Code's Miragon extension loads no plugins. Its extension points are
element templates (`configFolder`, `marketplaces`) and linting. Publishing the
generated templates as a Miragon marketplace (a repository with
`marketplace.json`) is the most it needs.

## Rules

- **Stay valid Zeebe.** Anything Struna adds must leave the file loadable in Camunda 8 editors, with the Zeebe namespace and `modeler:executionPlatform="Camunda Cloud"` unchanged.
- **Check at deploy, not at run time.** A malformed setting fails the deploy, not the run.
- **Declare field versions.** A new template field bumps `TEMPLATE_VERSION`, so editors offer the update.
