interface ZodDefLike {
  typeName?: string;
  shape?: () => Record<string, unknown>;
  innerType?: unknown;
  type?: unknown;
  values?: string[];
  description?: string;
  options?: unknown[];
  defaultValue?: () => unknown;
  /** ZodCatch's fallback factory (#390). */
  catchValue?: (ctx: { error: unknown; input: unknown }) => unknown;
  /** ZodEffects' wrapped schema (#390). */
  schema?: unknown;
  /** ZodLiteral's value (#390). */
  value?: unknown;
  /** ZodRecord's value type (#390). */
  valueType?: unknown;
}

function defOf(schema: unknown): ZodDefLike | undefined {
  return (schema as { _def?: ZodDefLike })?._def;
}

/** Wrap a schema so the value may also be null, in JSON-Schema terms (#243). */
function withNull(inner: Record<string, unknown>): Record<string, unknown> {
  if (typeof inner.type === "string") return { ...inner, type: [inner.type, "null"] };
  return { anyOf: [inner, { type: "null" }] };
}

/**
 * Convert a Zod v3 schema to a faithful JSON Schema — including enums, nested
 * objects/arrays, and required fields — so the local worker is told the real
 * output shape rather than a flat "everything is a string" map (#175).
 */
export function zodToJsonSchema(schema: unknown): Record<string, unknown> {
  const def = defOf(schema);
  if (!def) return { type: "object" };

  switch (def.typeName) {
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return { type: "string", enum: def.values ?? [] };
    case "ZodArray":
      return { type: "array", items: def.type ? zodToJsonSchema(def.type) : {} };
    case "ZodOptional":
      return def.innerType ? zodToJsonSchema(def.innerType) : {};
    case "ZodNullable":
      return def.innerType ? withNull(zodToJsonSchema(def.innerType)) : { type: "null" };
    case "ZodDefault": {
      // Unwrap to the inner type and advertise the default value (#243).
      const inner = def.innerType ? zodToJsonSchema(def.innerType) : {};
      if (typeof def.defaultValue === "function") {
        try { return { ...inner, default: def.defaultValue() }; } catch { /* ignore */ }
      }
      return inner;
    }
    case "ZodCatch": {
      // z.…​.catch(x) wraps its inner type. Without this case the whole schema
      // collapsed to {} — for classifyUserIntent that erased every property,
      // so the routing model got an unconstrained object and its output failed
      // validation (#390).
      const inner = def.innerType ? zodToJsonSchema(def.innerType) : {};
      if (typeof def.catchValue === "function") {
        try { return { ...inner, default: def.catchValue({ error: undefined, input: undefined }) }; } catch { /* ignore */ }
      }
      return inner;
    }
    case "ZodEffects":
      // .refine()/.transform() wrap a schema; describe the underlying shape
      // instead of emitting an unconstrained object (#390).
      return def.schema ? zodToJsonSchema(def.schema) : {};
    case "ZodLiteral":
      return def.value !== undefined
        ? { type: typeof def.value === "number" ? "number" : typeof def.value === "boolean" ? "boolean" : "string", enum: [def.value] }
        : {};
    case "ZodRecord":
      return { type: "object", additionalProperties: def.valueType ? zodToJsonSchema(def.valueType) : true };
    case "ZodUnion": {
      // e.g. spreadsheet cell `string | number` → anyOf, not a bare object (#243).
      const options = Array.isArray(def.options) ? def.options : [];
      return { anyOf: options.map((o) => zodToJsonSchema(o)) };
    }
    case "ZodObject": {
      const shape = typeof def.shape === "function" ? def.shape() : {};
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, val] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(val);
        const fieldType = defOf(val)?.typeName;
        // ZodCatch always yields a value, so it is never required either (#390).
        if (
          fieldType !== "ZodOptional" &&
          fieldType !== "ZodDefault" &&
          fieldType !== "ZodNullable" &&
          fieldType !== "ZodCatch"
        ) {
          required.push(key);
        }
      }
      const result: Record<string, unknown> = { type: "object", properties };
      if (required.length > 0) result.required = required;
      return result;
    }
    default:
      // Unknown/unsupported node (e.g. ZodEffects, ZodRecord). Emit an
      // unconstrained schema rather than mislabelling it as an object (#243).
      return {};
  }
}
