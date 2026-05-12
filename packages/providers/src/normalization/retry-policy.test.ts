import { describe, it, expect, vi } from "vitest";
import { RetryManager } from "./retry-policy.js";

describe("RetryManager", () => {
  it("retries on failure up to maxRetries", async () => {
    const manager = new RetryManager({ maxRetries: 3, backoffMs: 10, escalateOnFailure: false });

    let calls = 0;
    const result = await manager.execute(async () => {
      calls++;
      if (calls < 3) throw new Error("temp error");
      return "success";
    });

    expect(result).toBe("success");
    expect(calls).toBe(3);
  });

  it("throws after maxRetries exceeded", async () => {
    const manager = new RetryManager({ maxRetries: 3, backoffMs: 10, escalateOnFailure: false });

    let calls = 0;
    await expect(
      manager.execute(async () => {
        calls++;
        throw new Error("persistent error");
      }),
    ).rejects.toThrow("persistent error");
    expect(calls).toBe(3);
  });

  it("calls onError callback on failure", async () => {
    const onError = vi.fn();
    const manager = new RetryManager({ maxRetries: 3, backoffMs: 10, escalateOnFailure: false });

    await expect(
      manager.execute(
        async () => {
          throw new Error("fail");
        },
        onError,
      ),
    ).rejects.toThrow("fail");

    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("resets attempt counting", async () => {
    const manager = new RetryManager({ maxRetries: 1, backoffMs: 10, escalateOnFailure: false });

    await expect(
      manager.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    manager.reset();

    const result = await manager.execute(async () => "ok");
    expect(result).toBe("ok");
  });

  it("detects when escalation is needed", async () => {
    const manager = new RetryManager({ maxRetries: 2, backoffMs: 10, escalateOnFailure: true });

    await expect(
      manager.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    expect(manager.shouldEscalate).toBe(true);
  });

  it("respects backoff delay", async () => {
    const manager = new RetryManager({
      maxRetries: 2,
      backoffMs: 50,
      escalateOnFailure: false,
    });

    const start = Date.now();
    await expect(
      manager.execute(async () => {
        throw new Error("always fails");
      }),
    ).rejects.toThrow();

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });
});
