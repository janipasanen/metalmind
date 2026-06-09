import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "./zod-to-json-schema.js";

describe("zodToJsonSchema (#175)", () => {
  it("derives enums, nested objects/arrays, and required fields", () => {
    const schema = z.object({
      kind: z.enum(["a", "b"]),
      count: z.number(),
      nested: z.object({ name: z.string() }),
      items: z.array(z.string()),
      maybe: z.string().optional(),
    });
    const js = zodToJsonSchema(schema) as {
      type: string;
      properties: Record<string, { type?: string; enum?: string[]; items?: unknown; properties?: unknown }>;
      required: string[];
    };
    expect(js.type).toBe("object");
    expect(js.properties.kind).toEqual({ type: "string", enum: ["a", "b"] });
    expect(js.properties.count.type).toBe("number");
    expect(js.properties.nested.type).toBe("object");
    expect(js.properties.items).toEqual({ type: "array", items: { type: "string" } });
    // required includes everything except the optional field
    expect(js.required).toContain("kind");
    expect(js.required).toContain("nested");
    expect(js.required).not.toContain("maybe");
  });
});
