interface ZodDefLike {
  typeName?: string;
  shape?: () => Record<string, unknown>;
  innerType?: unknown;
  type?: unknown;
  values?: string[];
  description?: string;
}

function defOf(schema: unknown): ZodDefLike | undefined {
  return (schema as { _def?: ZodDefLike })?._def;
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
    case "ZodNullable":
    case "ZodDefault":
      return def.innerType ? zodToJsonSchema(def.innerType) : {};
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
      return { type: "object" };
  }
}
