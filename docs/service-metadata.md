# Service metadata from the proto

Status: design, not implemented. Written 2026-09-26.

## Where we are

A registered service gets its look from the registry database:

- **Title:** `--title` on `struna services add` (or `struna services appearance`); otherwise derived from the name, e.g. `acme.demo.v1.MathService` → "Math".
- **Icon:** `--icon` with an `.svg` or `.png` file; otherwise a generated monogram (`src/engine/icons.ts`).
- **Template field help:** the proto type and name only, e.g. `int32 · a` (`src/engine/templates.ts`).
- **Masking:** by key name, using `STRUNA_REDACT_KEYS` (`src/engine/payload.ts`).

So everything a service's owner knows about their API — what it is called,
what a field means, which field is a secret — has to be repeated by whoever
registers it, or is lost.

## Proposal

Read that metadata from the descriptor set Struna already stores. Three
sources, in the order they would be built.

### 1. Doc comments (no new options)

`buf build` keeps source info, and with it the doc comments, in the
descriptor set by default. Struna uses them where it now shows only types:

| Comment on | Used as |
| --- | --- |
| a service | its description in the dashboard's Services tab |
| a method | the element template's `description` (the editor's template picker) |
| a request field | the field's help text, before the type: `First addend · int32 · a` |
| a response field | the help text of its `Map … to` output field |

This works for every service with comments, with nothing to import. Missing
comments fall back to today's text. If a set was built with
`--exclude-source-info`, nothing changes.

### 2. Struna's own options

Struna ships `struna/v1/options.proto` with custom options a service may
import:

```proto
import "struna/v1/options.proto";

service MathService {
  option (struna.v1.service) = {
    title: "Math"
    icon: "https://acme.example/icons/math.svg"   // or a data: URI
  };

  rpc Add(AddRequest) returns (AddResponse) {
    option (struna.v1.method) = { title: "Add numbers" };
  }
}

message LoginRequest {
  string user = 1 [(struna.v1.field) = { label: "User name" }];
  string password = 2 [(struna.v1.field) = { sensitive: true }];
}
```

| Option | Field | Effect |
| --- | --- | --- |
| `struna.v1.service` | `title` | the service's name in editors, templates and the dashboard |
| `struna.v1.service` | `icon` | the icon, as a `data:` URI or an `https://` URL; a URL is fetched and stored at registration, with the same 64 KB limit as today |
| `struna.v1.method` | `title` | the method's name in the template (`Math › Add numbers` instead of `Math › Add`) |
| `struna.v1.field` | `label` | the template field's label, instead of the humanized proto name |
| `struna.v1.field` | `sensitive` | the field is masked in logs, events and the inspector wherever it appears, whatever its name |

- **Reading:** Struna reads the options with protobuf-es `getOption()`. The descriptor set bundles the imported `struna/v1/options.proto`, so the extensions resolve.
- **Publishing:** the options file needs a home services can depend on. That could be the Buf Schema Registry, or a copy vendored from this repository.
- **Optional:** a service that imports nothing keeps working exactly as today.

### 3. Standard annotations some APIs already use

- **`google.api.field_behavior`:**
  - `REQUIRED` fields are marked as required in the templates;
  - `OUTPUT_ONLY` fields are left out of the request fields.

## Precedence

Most specific wins:

1. **The registry's own setting:** `struna services add --title/--icon`, or `struna services appearance`. The operator can always override, which matters for third-party APIs whose proto they don't control.
2. **The proto option** (section 2).
3. **The derived default:** the title from the name, the monogram icon, and the help text from comments (section 1) or the type.

Clearing the operator setting (an empty `--title` / `--icon`) falls back to
the proto, not straight to the default. Masking combines the sources: a value
is masked if its key matches `STRUNA_REDACT_KEYS` **or** its field is marked
`sensitive`.

## Steps

1. **Doc comments** → template descriptions and help texts, and the Services tab.
2. **`struna.v1.service` title and icon**, under the registry override; then `struna.v1.method` title and `struna.v1.field` label.
3. **`struna.v1.field` sensitive** → masking, and add the option to the demo `LoginRequest`-style fields in `examples/services`.
4. **`google.api.field_behavior`** → required and output-only fields in the templates.

Each step bumps `TEMPLATE_VERSION` if it changes what the templates contain.
