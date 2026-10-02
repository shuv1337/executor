/** OpenAPI reference and dialect rules, shared by every part of the app importer. */
import { upgradeFromTwoToThree } from "@scalar/openapi-upgrader/2.0-to-3.0";
import { upgradeOpenApi30InPlace } from "./openapi-upgrade.ts";
import { yieldToRuntime } from "./runtime-yield.ts";
import { JsonPointer, JsonSchema, Schema } from "effect";
import { JsonObject } from "../contracts/schema.ts";
import { Specification } from "../contracts/openapi-document.ts";
import { OpenapiCompileError as TemplateError } from "../contracts/openapi-compile.ts";

/**
 * An object in a document that was validated as JSON when it was read. Compilation only turns JSON
 * into JSON, so inside it an object's shape is checked, not its every leaf again: re-validating
 * whole documents was most of a large API's compile time.
 */
export const DocumentObject = Schema.declare(
  (value: unknown): value is JsonObject =>
    typeof value === "object" && value !== null && !Array.isArray(value),
);
export const documentObject = Schema.decodeUnknownSync(DocumentObject);
const record = documentObject;
function fail(code: TemplateError["code"], reason: string): never {
  throw new TemplateError({ code, reason });
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** Fields that map names to Path Item Objects, whose `$ref` siblings extend the referenced item. */
const pathItemMaps = new Set(["paths", "webhooks", "pathItems"]);

/** The path of a local reference. Documents often leave characters such as `[` unencoded in the
 * fragment, so a fragment that is not a valid URI fragment is read as a plain JSON Pointer.
 */
const localPath = (ref: string): readonly string[] | undefined => {
  if (!ref.startsWith("#")) return undefined;
  const strict = JsonPointer.parseUriFragment(ref);
  if (strict !== undefined) return strict;
  let pointer = ref.slice(1);
  try {
    pointer = decodeURIComponent(pointer);
  } catch {
    // An invalid percent-encoding is read literally.
  }
  if (pointer === "") return [];
  return pointer.startsWith("/")
    ? pointer.slice(1).split("/").map(JsonPointer.unescapeToken)
    : undefined;
};

/** Replace the document's local Reference Objects with their targets in one walk.
 * Only the document itself is a reference scope: external, missing and circular references
 * stay in place, and operations that reach them are skipped when their objects are resolved.
 * A Reference Object's `summary` and `description` override its target's. A Path Item keeps
 * every sibling of its `$ref`. Schema Objects, examples and extensions are values, not objects
 * to resolve.
 */
function dereference(scope: JsonObject): JsonObject {
  const active = new Set<string>();
  const target = (ref: string): JsonObject | undefined => {
    const path = localPath(ref);
    let node: Schema.Json | undefined = scope;
    for (const part of path ?? []) {
      node = isObject(node)
        ? Object.hasOwn(node, part)
          ? node[part]
          : undefined
        : Array.isArray(node)
          ? node[Number(part)]
          : undefined;
      if (node === undefined) return;
    }
    return path !== undefined && isObject(node) ? node : undefined;
  };
  const fields = (object: JsonObject): JsonObject => {
    const result: Record<string, Schema.Json> = {};
    for (const [key, value] of Object.entries(object))
      result[key] =
        key === "schema"
          ? value
          : key === "example" || key.startsWith("x-")
            ? value
            : pathItemMaps.has(key) && isObject(value)
              ? Object.fromEntries(
                  Object.entries(value).map(([name, item]) => [name, visit(item, true)]),
                )
              : key === "responses"
                ? defaultFirst(visit(value, false))
                : visit(value, false);
    return result;
  };
  // A Responses Object lists its fixed `default` field before status codes, as the importer
  // always stored it.
  const defaultFirst = (responses: Schema.Json): Schema.Json => {
    if (!isObject(responses) || !Object.hasOwn(responses, "default")) return responses;
    const { default: fallback, ...statuses } = responses;
    return { default: fallback ?? null, ...statuses };
  };
  const visit = (value: Schema.Json, pathItem: boolean): Schema.Json => {
    if (Array.isArray(value)) return value.map((item) => visit(item, false));
    if (!isObject(value)) return value;
    const ref = value.$ref;
    const found = typeof ref === "string" && !active.has(ref) ? target(ref) : undefined;
    if (typeof ref !== "string" || found === undefined) return fields(value);
    active.add(ref);
    const resolved = visit(found, pathItem);
    active.delete(ref);
    if (!isObject(resolved)) return resolved;
    const { $ref: _, ...siblings } = value;
    if (pathItem) return { ...resolved, ...fields(siblings) };
    return {
      ...resolved,
      ...(typeof siblings.summary === "string" ? { summary: siblings.summary } : {}),
      ...(typeof siblings.description === "string" ? { description: siblings.description } : {}),
    };
  };
  return record(visit(scope, false));
}

/** The document's specification, with its paths and components checked for shape. */
const DocumentSpecification = Schema.Struct({
  ...Specification.fields,
  paths: Schema.Record(Schema.String, DocumentObject),
  components: Schema.optionalKey(
    Schema.Struct({
      schemas: Schema.optionalKey(Schema.Record(Schema.String, DocumentObject)),
      securitySchemes: Schema.optionalKey(Schema.Record(Schema.String, DocumentObject)),
    }),
  ),
});

/** Upgrade a document the caller owns to OpenAPI 3.1, as Scalar's upgrader does: Swagger 2.0 is
 * first converted to 3.0, a 3.0 document is upgraded in place and a 3.1 document is unchanged.
 */
function upgradeOwned(document: JsonObject): JsonObject {
  return record(upgradeOpenApi30InPlace(record(upgradeFromTwoToThree(document))));
}

/** Resolve OpenAPI objects once; schemas retain their original recursive references.
 * Scalar first upgrades Swagger 2.0 and OpenAPI 3.0 to 3.1, so the importer has one dialect and
 * 3.1 keywords that appear in 3.0 documents keep their meaning.
 * Unsupported versions, references and conversions throw TemplateError at the import boundary.
 */
export async function openApiDocument(input: JsonObject) {
  // The caller hands over the document; each original entry is released as it is upgraded.
  const root = upgradeOwned(record(input));
  await yieldToRuntime();
  const spec = Schema.decodeUnknownSync(DocumentSpecification)(root);
  if (!spec.openapi.startsWith("3.1."))
    fail("openapi_version", "This importer supports Swagger 2.0 and OpenAPI 3.0 and 3.1.");
  const components = spec.components?.schemas ?? {};
  const convert = JsonSchema.fromSchemaOpenApi3_1;

  // Schema Objects are opaque to the object resolver. Effect owns their dialect,
  // reference siblings and recursion, so component schemas are not reference targets here.
  const componentsObject = root.components === undefined ? {} : record(root.components);
  const restored = dereference({ ...root, components: { ...componentsObject, schemas: {} } });
  await yieldToRuntime();
  const parsed = Schema.decodeUnknownSync(DocumentSpecification)({
    ...restored,
    components: { ...record(restored.components), schemas: components },
  });

  // Component schemas converted once for the whole app. Operation schemas keep
  // `#/$defs/<name>` references; the runtime attaches the definitions a schema reaches.
  const definitions = new Map<string, JsonObject>();
  // Component names each definition references directly, for transitive reach checks.
  const references = new Map<string, ReadonlySet<string>>();

  return {
    spec: parsed,
    definitions,
    /** Inspect a component schema without expanding its children. OpenAPI object refs must already be resolved by Swagger. */
    resolve(value: JsonObject): JsonObject {
      const visited = new Set<string>();
      while (value.$ref !== undefined) {
        const ref = value.$ref;
        const path = typeof ref === "string" ? JsonPointer.parseUriFragment(ref) : undefined;
        if (
          typeof ref !== "string" ||
          path?.length !== 3 ||
          path[0] !== "components" ||
          path[1] !== "schemas" ||
          path[2] === undefined
        )
          fail("external_reference", "An OpenAPI object reference could not be resolved locally.");
        if (visited.has(ref))
          fail("circular_reference", "A circular schema alias cannot be imported.");
        visited.add(ref);
        value = record(Object.hasOwn(components, path[2]) ? components[path[2]] : undefined);
      }
      return value;
    },
    /** Compose a Draft 2020-12 schema around API Schema Objects. Only values passed to
     * `api` use the document's OpenAPI dialect; Executor-authored wrappers are already
     * Draft 2020-12 and must not be reinterpreted. Reached components are converted once into
     * the shared `definitions` and stay references here; nothing is inlined or copied per operation.
     */
    schema(build: (api: (input: Schema.Json) => JsonObject) => JsonObject): JsonObject {
      const added: string[] = [];
      const direct = new Set<string>();
      const local: Record<string, Schema.Json> = {};
      const visit = (input: JsonObject, direct: Set<string>): JsonObject => {
        const document = convert(input, {
          onReference(ref) {
            const path = JsonPointer.parseUriFragment(ref);
            const name = path?.[2];
            if (
              path?.length !== 3 ||
              path[0] !== "components" ||
              path[1] !== "schemas" ||
              name === undefined
            )
              fail("schema_reference", "Only local component schema references are supported.");
            const component = Object.hasOwn(components, name) ? components[name] : undefined;
            if (component === undefined)
              fail("missing_component", "An API schema references a missing component.");
            direct.add(name);
            if (!definitions.has(name)) {
              // The placeholder ends recursion; a cycle stays a reference to the same definition.
              added.push(name);
              definitions.set(name, {});
              const names = new Set<string>();
              definitions.set(name, visit(component, names));
              references.set(name, names);
            }
          },
        });
        return record({
          ...document.schema,
          ...(Object.keys(document.definitions).length ? { $defs: document.definitions } : {}),
        });
      };
      const api = (input: Schema.Json): JsonObject => {
        const { $defs, ...converted } = visit(record(input), direct);
        for (const [name, definition] of Object.entries($defs === undefined ? {} : record($defs))) {
          if (
            Object.hasOwn(local, name) &&
            JSON.stringify(local[name]) !== JSON.stringify(definition)
          )
            fail("schema_reference", "An API schema has conflicting local definitions.");
          local[name] = definition;
        }
        return converted;
      };
      try {
        const converted = build(api);
        if (Object.keys(local).length) {
          // Local definitions share the `$defs` scope with every component this schema reaches.
          const reached = new Set<string>();
          const pending = [...direct];
          for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
            if (reached.has(name)) continue;
            reached.add(name);
            pending.push(...(references.get(name) ?? []));
          }
          if ([...reached].some((name) => Object.hasOwn(local, name)))
            fail(
              "schema_reference",
              "An API schema has conflicting local and component definitions.",
            );
        }
        return {
          ...converted,
          ...(Object.keys(local).length ? { $defs: local } : {}),
          $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
        };
      } catch (error) {
        // A failed conversion leaves no placeholder or partial definition for later schemas.
        for (const name of added) {
          definitions.delete(name);
          references.delete(name);
        }
        if (error instanceof TemplateError) throw error;
        return fail(
          "schema_keyword",
          "An API schema cannot be converted without changing its constraints.",
        );
      }
    },
  };
}

/** A parsed document with one reference scope and one schema dialect. */
export type OpenApiDocument = Awaited<ReturnType<typeof openApiDocument>>;
