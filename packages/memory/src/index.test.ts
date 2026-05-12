import { describe, it, expect } from "vitest";
import { SessionStore } from "../src/index.js";

describe("SessionStore", () => {
  it("saves and loads sessions", async () => {
    const store = new SessionStore();
    await store.save("session1", [{ role: "user", content: "hi" }]);
    const msgs = await store.load("session1");
    expect(msgs).toHaveLength(1);
  });

  it("returns empty for unknown session", async () => {
    const store = new SessionStore();
    expect(await store.load("nonexistent")).toEqual([]);
  });

  it("lists session IDs", async () => {
    const store = new SessionStore();
    await store.save("a", []);
    await store.save("b", []);
    const ids = await store.list();
    expect(ids).toContain("a");
    expect(ids).toContain("b");
  });

  it("deletes sessions", async () => {
    const store = new SessionStore();
    await store.save("x", []);
    await store.delete("x");
    expect(await store.load("x")).toEqual([]);
  });
});
