import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import MultiAgentStatus from "../components/MultiAgentStatus.js";
import StatusBar from "../components/StatusBar.js";

describe("MultiAgentStatus worker display (#257)", () => {
  it("shows the worker when a provider is available, even with no model string", () => {
    const { lastFrame } = render(
      <MultiAgentStatus
        mainModel="claude" mainProvider="anthropic"
        localWorkerProvider="ollama" localWorkerAvailable={true}
        phase="idle"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Worker:");
    expect(frame).toContain("ollama");
    expect(frame).not.toContain("none configured");
  });

  it("falls back to 'none configured' only when there is no worker provider", () => {
    const { lastFrame } = render(
      <MultiAgentStatus mainModel="claude" mainProvider="anthropic" phase="idle" />,
    );
    expect(lastFrame() ?? "").toContain("none configured");
  });
});

describe("MultiAgentStatus collapse is controlled (#266)", () => {
  it("renders the compact line when collapsed", () => {
    const { lastFrame } = render(
      <MultiAgentStatus mainModel="claude" mainProvider="anthropic" phase="idle" collapsed={true} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("to expand");
    expect(frame).not.toContain("Phase:"); // expanded-only content
  });

  it("renders the full panel when not collapsed", () => {
    const { lastFrame } = render(
      <MultiAgentStatus mainModel="claude" mainProvider="anthropic" phase="idle" collapsed={false} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Phase:");
    expect(frame).toContain("to collapse");
  });
});

describe("StatusBar MCP footer (#267)", () => {
  it("renders connected MCP servers and tool count", () => {
    const { lastFrame } = render(
      <StatusBar
        focusPanel="input"
        mcpServers={[
          { name: "github", connected: true, toolCount: 3 },
          { name: "offline-one", connected: false, toolCount: 0 },
        ]}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("MCP: github");
    expect(frame).toContain("3 tools");
    expect(frame).not.toContain("offline-one");
  });

  it("renders no MCP footer when none are connected", () => {
    const { lastFrame } = render(<StatusBar focusPanel="input" mcpServers={[]} />);
    expect(lastFrame() ?? "").not.toContain("MCP:");
  });
});
