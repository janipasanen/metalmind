import { describe, it, expect, afterEach } from "vitest";
import {
  runBackgroundTool,
  pollBackgroundTool,
  stopBackgroundTool,
  listBackgroundProcesses,
  _resetBackgroundRegistry,
} from "./background-tools.js";

const ctx = { projectRoot: process.cwd() } as never;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("background shell tools (#153)", () => {
  afterEach(() => {
    _resetBackgroundRegistry();
  });

  it("starts a process and returns control immediately with an id", async () => {
    const out = await runBackgroundTool.execute(
      { command: `node -e "console.log('hello-bg'); setTimeout(()=>{}, 500)"` },
      ctx,
    );
    expect(out).toMatch(/Started background process \[bg-\d+\]/);
  });

  it("polls accumulated output by id", async () => {
    const start = await runBackgroundTool.execute(
      { command: `node -e "console.log('tick-1')"` },
      ctx,
    );
    const id = /\[(bg-\d+)\]/.exec(start)![1];
    await sleep(300); // let it emit + exit
    const polled = await pollBackgroundTool.execute({ id }, ctx);
    expect(polled).toContain("tick-1");
    expect(polled).toMatch(/exited \(code 0\)/);
  });

  it("stops a long-running process", async () => {
    const start = await runBackgroundTool.execute(
      { command: `node -e "setInterval(()=>console.log('loop'), 50)"` },
      ctx,
    );
    const id = /\[(bg-\d+)\]/.exec(start)![1];
    await sleep(150);
    const stopped = await stopBackgroundTool.execute({ id }, ctx);
    expect(stopped).toMatch(/SIGTERM/);
    await sleep(150);
    const polled = await pollBackgroundTool.execute({ id }, ctx);
    expect(polled).toMatch(/stopped|exited/);
  });

  it("lists tracked processes and reports unknown ids cleanly", async () => {
    await runBackgroundTool.execute({ command: `node -e "setTimeout(()=>{},300)"` }, ctx);
    expect(listBackgroundProcesses()).toMatch(/\[bg-\d+\]/);
    expect(await pollBackgroundTool.execute({ id: "bg-does-not-exist" }, ctx)).toMatch(/No background process/);
  });
});
