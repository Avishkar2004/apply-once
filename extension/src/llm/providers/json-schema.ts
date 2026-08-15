/**
 * JSON Schema dialect fixes.
 *
 * `z.toJSONSchema()` emits draft 2020-12 with `additionalProperties: false` and
 * a full `required` list already, which is exactly what OpenAI-compatible strict
 * mode wants — bar the `$schema` key, which several gateways reject outright.
 *
 * Gemini is the odd one out: `responseSchema` is an OpenAPI 3.0 subset with
 * upper-case type names and no `additionalProperties`, so it gets its own
 * conversion rather than a shared lowest common denominator.
 */

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Draft 2020-12, minus the keys strict-mode gateways refuse. */
export function toStrictJsonSchema(schema: JsonRecord): JsonRecord {
  const { $schema: _dialect, ...rest } = schema;
  return rest;
}

/** Keys Gemini's OpenAPI-subset validator rejects outright. */
const GEMINI_UNSUPPORTED = new Set([
  '$schema',
  'additionalProperties',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'const',
  '$defs',
  '$ref',
]);

/**
 * Convert to Gemini's `responseSchema` subset.
 *
 * Types become upper case (`OBJECT`, not `object`) because the field is a
 * protobuf enum and protobuf JSON matches enum *names*, case-sensitively.
 */
export function toGeminiSchema(schema: JsonRecord): JsonRecord {
  const out: JsonRecord = {};

  for (const [key, value] of Object.entries(schema)) {
    if (GEMINI_UNSUPPORTED.has(key)) continue;

    if (key === 'type' && typeof value === 'string') {
      out.type = value.toUpperCase();
    } else if (key === 'properties' && isRecord(value)) {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          isRecord(child) ? toGeminiSchema(child) : child,
        ]),
      );
    } else if (key === 'items' && isRecord(value)) {
      out.items = toGeminiSchema(value);
    } else if (isRecord(value)) {
      out[key] = toGeminiSchema(value);
    } else {
      out[key] = value;
    }
  }

  return out;
}
