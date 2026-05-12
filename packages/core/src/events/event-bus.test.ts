import { describe, it, expect, vi } from "vitest";
import { EventBus } from "./event-bus.js";

describe("EventBus", () => {
  it("calls registered handlers on emit", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on("test", handler);
    bus.emit("test", "arg1", 42);
    expect(handler).toHaveBeenCalledWith("arg1", 42);
  });

  it("does not call removed handlers", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on("test", handler);
    bus.off("test", handler);
    bus.emit("test");
    expect(handler).not.toHaveBeenCalled();
  });

  it("handles events with no listeners gracefully", () => {
    const bus = new EventBus();
    expect(() => bus.emit("nonexistent")).not.toThrow();
  });

  it("supports multiple handlers for same event", () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on("test", h1);
    bus.on("test", h2);
    bus.emit("test");
    expect(h1).toHaveBeenCalled();
    expect(h2).toHaveBeenCalled();
  });

  it("clears all handlers", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on("test", handler);
    bus.clear();
    bus.emit("test");
    expect(handler).not.toHaveBeenCalled();
  });
});
