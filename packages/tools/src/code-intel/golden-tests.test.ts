import { describe, it, expect } from "vitest";
import { parseSource } from "./tree-sitter-parser.js";

describe("Golden tests — code structure extraction", () => {
  it("extracts symbols from a typical TypeScript module", () => {
    const source = `
      import { useState } from "react";
      
      interface Props {
        title: string;
        count: number;
      }
      
      export function MyComponent({ title, count }: Props) {
        const [state, setState] = useState(0);
        return <div>{title}: {count + state}</div>;
      }
      
      export default MyComponent;
    `;

    const result = parseSource(source, "MyComponent.tsx");

    expect(result.imports.length).toBeGreaterThanOrEqual(1);
    expect(result.imports[0]?.source).toBe("react");

    const functions = result.symbols.filter((s) => s.kind === "function");
    expect(functions.length).toBeGreaterThanOrEqual(1);

    const interfaces = result.symbols.filter((s) => s.kind === "interface");
    expect(interfaces.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts classes with inheritance", () => {
    const source = `
      export class BaseController {
        protected async init() {}
      }
      
      export class UserController extends BaseController {
        async getUsers() { return []; }
        async createUser(data: unknown) { return {}; }
      }
    `;

    const result = parseSource(source, "controller.ts");

    const classes = result.symbols.filter((s) => s.kind === "class");
    expect(classes.length).toBeGreaterThanOrEqual(2);
    expect(classes.filter((c) => c.exported).length).toBeGreaterThanOrEqual(1);
  });

  it("handles TypeScript generics and type parameters", () => {
    const source = `
      export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
      
      export function mapResult<T, U>(r: Result<T>, f: (v: T) => U): Result<U> {
        if (r.ok) return { ok: true, value: f(r.value) };
        return r;
      }
      
      export interface Repository<T> {
        find(id: string): Promise<T>;
        save(entity: T): Promise<void>;
      }
    `;

    const result = parseSource(source, "result.ts");

    const types = result.symbols.filter((s) => s.kind === "type");
    expect(types.length).toBeGreaterThanOrEqual(1);

    const functions = result.symbols.filter((s) => s.kind === "function");
    expect(functions.length).toBeGreaterThanOrEqual(1);

    const interfaces = result.symbols.filter((s) => s.kind === "interface");
    expect(interfaces.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts enums with values", () => {
    const source = `
      export enum Status {
        Active = "active",
        Inactive = "inactive",
        Pending = "pending",
      }
      
      function getStatusLabel(s: Status): string {
        switch (s) {
          case Status.Active: return "Active";
          case Status.Inactive: return "Inactive";
          default: return "Unknown";
        }
      }
    `;

    const result = parseSource(source, "status.ts");

    const enums = result.symbols.filter((s) => s.kind === "enum");
    expect(enums.length).toBeGreaterThanOrEqual(1);
    expect(enums[0]?.exported).toBe(true);
  });
});
