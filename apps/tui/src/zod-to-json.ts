import type { ZodSchema } from "zod";

type ZodDef = {
  typeName: string;
  shape?: () => Record<string, ZodSchema>;
  innerType?: ZodSchema;
  type?: ZodSchema;
  values?: string[];
};

/** Convert a Zod v3 schema to a plain JSON Schema object for use in LLM tool definitions. */
export function zodToJsonSchema(schema: ZodSchema): Record<string, unknown> {
  const def = (schema as unknown as { _def: ZodDef })._def;
  switch (def.typeName) {
    case "ZodString":   return { type: "string" };
    case "ZodNumber":   return { type: "number" };
    case "ZodBoolean":  return { type: "boolean" };
    case "ZodEnum":     return { type: "string", enum: def.values ?? [] };
    case "ZodArray":    return { type: "array", items: def.type ? zodToJsonSchema(def.type) : {} };
    case "ZodOptional":
    case "ZodNullable": return def.innerType ? zodToJsonSchema(def.innerType) : {};
    case "ZodDefault":  return def.innerType ? zodToJsonSchema(def.innerType) : {};
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
      return { type: "object" };
  }
}
