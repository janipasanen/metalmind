import { describe, it, expect, beforeAll, afterAll } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import App from "../components/App.js";

/**
 * Real command-dispatcher tests (#335): render the actual <App>, type into the
 * actual InputBar, and assert on what the real generateResponse dispatcher
 * renders. Replaces commands.test.ts, which asserted against a hand-rolled
 * reimplementation of the dispatcher — a duplicate that could (and did) drift
 * from the code users actually run.
 *
 * Only agent-free commands are exercised (/help, /search, unknown-command
 * hint): they complete without a model/provider round-trip, so the tests stay
 * hermetic while still driving the genuine dispatch path end to end.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function typeCommand(stdin: { write(s: string): void }, cmd: string): Promise<void> {
  stdin.write(cmd);
  await sleep(60);
  stdin.write("\r");
  await sleep(350);
}

describe("App command dispatcher (real path, #335)", () => {
  let dir: string;
  let prevCwd: string;

  beforeAll(() => {
    prevCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "mm-appdispatch-"));
    process.chdir(dir); // keep .metalmind/session side effects out of the repo
  });

  afterAll(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("dispatches /help through the real handler and renders the command list", async () => {
    const { stdin, lastFrame, unmount } = render(
      <App config={{ provider: "ollama", model: "test-model", explicit: true }} />,
    );
    await sleep(400); // let the agent-construction effect settle
    await typeCommand(stdin, "/help");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Available commands");
    expect(frame).toContain("/doctor");
    expect(frame).toContain("/search");
    unmount();
  });

  it("dispatches /search through the real handler (no matches case)", async () => {
    const { stdin, lastFrame, unmount } = render(
      <App config={{ provider: "ollama", model: "test-model", explicit: true }} />,
    );
    await sleep(400);
    await typeCommand(stdin, "/search zebra-xyzzy");
    expect(lastFrame() ?? "").toContain("No matches");
    unmount();
  });

  it("hints at custom commands for an unknown slash command", async () => {
    const { stdin, lastFrame, unmount } = render(
      <App config={{ provider: "ollama", model: "test-model", explicit: true }} />,
    );
    await sleep(400);
    await typeCommand(stdin, "/nosuchcommand");
    expect(lastFrame() ?? "").toContain(".metalmind/commands");
    unmount();
  });
});
