import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import FileTree from "../components/FileTree.js";
import Notifications from "../components/Notifications.js";

describe("FileTree (legacy #9)", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `mm-tree-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true }); // must be ignored
    writeFileSync(join(root, "src", "index.ts"), "x");
    writeFileSync(join(root, "README.md"), "x");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("renders the project root expanded with its children, ignoring vendored dirs", () => {
    const { lastFrame } = render(<FileTree root={root} onClose={() => {}} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("src/");
    expect(frame).toContain("README.md");
    expect(frame).not.toContain("node_modules");
    expect(frame).toMatch(/expand/); // help hint
  });

  it("lists directories before files", () => {
    const { lastFrame } = render(<FileTree root={root} onClose={() => {}} />);
    const frame = lastFrame() ?? "";
    expect(frame.indexOf("src/")).toBeLessThan(frame.indexOf("README.md"));
  });
});

describe("Notifications (legacy #8)", () => {
  it("renders each notification with its message", () => {
    const { lastFrame } = render(
      <Notifications
        items={[
          { id: 1, type: "error", message: "boom happened" },
          { id: 2, type: "success", message: "all good" },
        ]}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("boom happened");
    expect(frame).toContain("all good");
  });

  it("renders nothing when empty", () => {
    const { lastFrame } = render(<Notifications items={[]} />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });
});
