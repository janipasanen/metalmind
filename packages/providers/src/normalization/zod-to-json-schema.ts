interface ZodDefLike {
  typeName?: string;
  shape?: () => Record<string, unknown>;
  innerType?: unknown;
  type?: unknown;
  values?: string[];
  description?: string;
  options?: unknown[];
  defaultValue?: () => unknown;
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
        if (fieldType !== "ZodOptional" && fieldType !== "ZodDefault" && fieldType !== "ZodNullable") {
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
