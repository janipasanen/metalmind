import { describe, it, expect } from "vitest";
import { JsonRepair } from "./json-repair.js";

describe("JsonRepair", () => {
  it("removes trailing commas", () => {
    const input = '{"a": 1,}';
    const result = JsonRepair.repair(input);
    expect(JSON.parse.bind(null, result)).not.toThrow();
    expect(JSON.parse(result)).toEqual({ a: 1 });
  });

  it("removes trailing commas in arrays", () => {
    const input = '{"items": [1, 2,]}';
    const result = JsonRepair.repair(input);
    expect(JSON.parse(result)).toEqual({ items: [1, 2] });
  });

  it("fixes single quotes to double quotes", () => {
    const input = "{'key': 'value'}";
    const result = JsonRepair.repair(input);
    expect(JSON.parse(result)).toEqual({ key: "value" });
  });

  it("fixes unquoted keys", () => {
    const input = "{key: 1, nested_key: 2}";
    const result = JsonRepair.repair(input);
    expect(JSON.parse(result)).toEqual({ key: 1, nested_key: 2 });
  });

  it("removes single-line comments", () => {
    const input = `{
  // this is a comment
  "key": "value"
}`;
    const result = JsonRepair.repair(input);
    expect(JSON.parse(result)).toEqual({ key: "value" });
  });

  it("removes block comments", () => {
    const input = `{
  /* block
     comment */
  "key": "value"
}`;
    const result = JsonRepair.repair(input);
    expect(JSON.parse(result)).toEqual({ key: "value" });
  });

  it("returns original on fatal error", () => {
    const input = "not { json [";
    const result = JsonRepair.repair(input);
    expect(result).toBe(input);
  });

  it("fixes malformed JSON from model outputs", () => {
    const input = `{
  tool: "readFile",
  arguments: {path: "/test.ts",}
}`;
    const result = JsonRepair.repair(input);
    const parsed = JSON.parse(result);
    expect(parsed.tool).toBe("readFile");
    expect(parsed.arguments.path).toBe("/test.ts");
  });
});
