import type { ZodSchema } from "zod";

type ZodDef = {
  typeName: string;
  shape?: () => Record<string, ZodSchema>;
  innerType?: ZodSchema;
  type?: ZodSchema;
  values?: string[];
  options?: ZodSchema[];
  defaultValue?: () => unknown;
};

/** Wrap a schema so the value may also be null, in JSON-Schema terms (#243). */
function withNull(inner: Record<string, unknown>): Record<string, unknown> {
  if (typeof inner.type === "string") return { ...inner, type: [inner.type, "null"] };
  return { anyOf: [inner, { type: "null" }] };
}

/** Convert a Zod v3 schema to a plain JSON Schema object for use in LLM tool definitions. */
export function zodToJsonSchema(schema: ZodSchema): Record<string, unknown> {
  const def = (schema as unknown as { _def: ZodDef })._def;
  switch (def.typeName) {
    case "ZodString":   return { type: "string" };
    case "ZodNumber":   return { type: "number" };
    case "ZodBoolean":  return { type: "boolean" };
    case "ZodEnum":     return { type: "string", enum: def.values ?? [] };
    case "ZodArray":    return { type: "array", items: def.type ? zodToJsonSchema(def.type) : {} };
    case "ZodOptional": return def.innerType ? zodToJsonSchema(def.innerType) : {};
    case "ZodNullable": return def.innerType ? withNull(zodToJsonSchema(def.innerType)) : { type: "null" };
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
      const options = def.options ?? [];
      return { anyOf: options.map((o) => zodToJsonSchema(o)) };
    }
    case "ZodObject": {
      const shape = def.shape?.() ?? {};
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, val] of Object.entries(shape)) {
        const fieldDef = (val as unknown as { _def: ZodDef })._def;
        properties[key] = zodToJsonSchema(val);
        if (fieldDef.typeName !== "ZodOptional" && fieldDef.typeName !== "ZodDefault") {
          required.push(key);
        }
      }
      const result: Record<string, unknown> = { type: "object", properties };
      if (required.length > 0) result.required = required;
      return result;
    }
    default:
      // Unknown/unsupported node (e.g. ZodEffects, ZodRecord). Emit an
      // unconstrained schema ({}) rather than mislabelling it as an object,
      // so the model isn't told a value must be an object when it needn't be (#243).
      return {};
  }
}
