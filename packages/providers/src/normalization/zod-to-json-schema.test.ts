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

  it("renders a union as anyOf instead of a bare object (#243)", () => {
    const js = zodToJsonSchema(z.union([z.string(), z.number()])) as { anyOf: Array<{ type: string }> };
    expect(js.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
  });

  it("unwraps ZodDefault and advertises the default value (#243)", () => {
    const js = zodToJsonSchema(z.string().default("hi")) as { type: string; default: string };
    expect(js.type).toBe("string");
    expect(js.default).toBe("hi");
  });

  it("keeps the null type for a nullable field (#243)", () => {
    const js = zodToJsonSchema(z.string().nullable()) as { type: string[] };
    expect(js.type).toEqual(["string", "null"]);
  });

  it("admits null on a nullable object via a type array (#243)", () => {
    const js = zodToJsonSchema(z.object({ a: z.string() }).nullable()) as { type: string[]; properties: unknown };
    expect(js.type).toEqual(["object", "null"]);
    expect(js.properties).toEqual({ a: { type: "string" } });
  });

  it("wraps a type-less schema (a union) in anyOf with null (#243)", () => {
    const js = zodToJsonSchema(z.union([z.string(), z.number()]).nullable()) as { anyOf: unknown[] };
    expect(js.anyOf).toContainEqual({ type: "null" });
    expect(js.anyOf).toContainEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
  });

  it("emits an unconstrained schema for unsupported nodes rather than mislabelling them as objects (#243)", () => {
    // ZodRecord isn't modelled — it must not be advertised as {type:'object'}.
    const js = zodToJsonSchema(z.record(z.string()));
    expect(js).toEqual({});
  });

  it("advertises a union-typed object field (e.g. a spreadsheet cell) (#243)", () => {
    const schema = z.object({ cell: z.union([z.string(), z.number()]) });
    const js = zodToJsonSchema(schema) as { properties: Record<string, { anyOf?: unknown[] }> };
    expect(js.properties.cell.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
  });
});
