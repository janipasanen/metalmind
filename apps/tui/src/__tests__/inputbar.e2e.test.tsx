import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import InputBar from "../components/InputBar.js";
import StatusBar from "../components/StatusBar.js";
import Header from "../components/Header.js";

/**
 * End-to-end tests that render the real Ink components and assert on their output
 * (#215) — Ink components were previously untested. These exercise the actual
 * render paths (context gauge, token meter, header, input states) headlessly.
 */

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("Ink component e2e (#215)", () => {
  it("Header shows the project and model", () => {
    const { lastFrame } = render(<Header projectName="metalmind" modelName="ollama/ministral-3:3b" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("metalmind");
    expect(frame).toContain("ministral-3:3b");
  });

  it("StatusBar renders the context gauge and token meter", () => {
    const { lastFrame } = render(
      <StatusBar
        focusPanel="input"
        context={{ used: 8000, limit: 32000 }}
        usage={{ inputTokens: 1200, outputTokens: 340 }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ctx"); // context-window gauge (#141)
    expect(frame).toContain("25%"); // 8000 / 32000
  });

  it("InputBar shows the prompt and disables input while streaming", async () => {
    const onSubmit = vi.fn();
    const active = render(<InputBar onSubmit={onSubmit} />);
    expect(active.lastFrame()).toContain(">");

    const streaming = render(<InputBar onSubmit={onSubmit} disabled />);
    expect(streaming.lastFrame()).toContain("streaming");
    streaming.stdin.write("ignored\r");
    await tick();
    expect(onSubmit).not.toHaveBeenCalled(); // disabled input is inert
  });
});
