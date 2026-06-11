import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { pageWindow } from "../paging.js";
import ChatView from "../components/ChatView.js";
import type { ChatMessage } from "../components/App.js";

describe("pageWindow (#159)", () => {
  it("shows the last page at offset 0 (live tail)", () => {
    const w = pageWindow(50, 0, 12);
    expect(w).toMatchObject({ start: 38, end: 50, hiddenAbove: 38, hiddenBelow: 0, offset: 0 });
  });

  it("scrolls up by the offset", () => {
    const w = pageWindow(50, 12, 12);
    expect(w).toMatchObject({ start: 26, end: 38, hiddenAbove: 26, hiddenBelow: 12 });
  });

  it("clamps overscroll to the top", () => {
    const w = pageWindow(50, 999, 12);
    expect(w.start).toBe(0);
    expect(w.offset).toBe(38); // max offset = total - pageSize
    expect(w.hiddenAbove).toBe(0);
  });

  it("handles fewer messages than a page", () => {
    expect(pageWindow(5, 0, 12)).toMatchObject({ start: 0, end: 5, hiddenAbove: 0, hiddenBelow: 0 });
  });
});

describe("ChatView scrollback (#159)", () => {
  const msgs = (n: number): ChatMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `m${i}`,
      role: "user" as const,
      content: `message-${i}`,
      timestamp: new Date(0),
    }));

  it("shows the 'earlier messages' indicator and only the visible window", () => {
    const { lastFrame } = render(
      <ChatView messages={msgs(30)} streamingContent="" activeToolCalls={[]} isStreaming={false} pageSize={5} scrollOffset={0} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("25 earlier messages");
    expect(frame).toContain("message-29"); // tail visible
    expect(frame).not.toContain("message-10"); // scrolled-out
  });

  it("reveals older messages when scrolled up", () => {
    const { lastFrame } = render(
      <ChatView messages={msgs(30)} streamingContent="" activeToolCalls={[]} isStreaming={false} pageSize={5} scrollOffset={20} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("message-5"); // older window now visible
    expect(frame).toContain("newer message"); // bottom indicator
  });
});
