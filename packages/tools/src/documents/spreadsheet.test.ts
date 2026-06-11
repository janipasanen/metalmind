import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildXlsx,
  buildOds,
  rowsToCsv,
  csvToRows,
  columnLetter,
  createXlsxTool,
  createOdsTool,
  createCsvTool,
  writeDocumentTool,
} from "./index.js";
import { buildZip, crc32 } from "./zip.js";
import type { ToolExecutionContext } from "../types.js";

describe("zip writer (#188/#189 foundation)", () => {
  it("computes the standard CRC-32 of an ASCII string", () => {
    // Known CRC32("123456789") = 0xCBF43926.
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("produces a ZIP that the system `unzip` can read back", () => {
    const zip = buildZip([
      { name: "a.txt", data: "hello" },
      { name: "dir/b.txt", data: "world" },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "mm-zip-"));
    const zpath = join(dir, "t.zip");
    require("node:fs").writeFileSync(zpath, zip);
    try {
      const listing = execFileSync("unzip", ["-l", zpath], { encoding: "utf-8" });
      expect(listing).toContain("a.txt");
      expect(listing).toContain("dir/b.txt");
      const content = execFileSync("unzip", ["-p", zpath, "a.txt"], { encoding: "utf-8" });
      expect(content).toBe("hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("spreadsheet builders (#188 xlsx, #189 ods)", () => {
  it("maps column indices to letters", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
  });

  it("xlsx is a valid zip containing the workbook + sheet with our data", () => {
    const buf = buildXlsx([{ name: "Data", rows: [["Name", "Score"], ["Ada", 99]] }]);
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
    const dir = mkdtempSync(join(tmpdir(), "mm-xlsx-"));
    const f = join(dir, "w.xlsx");
    require("node:fs").writeFileSync(f, buf);
    try {
      const names = execFileSync("unzip", ["-l", f], { encoding: "utf-8" });
      expect(names).toContain("xl/workbook.xml");
      expect(names).toContain("xl/worksheets/sheet1.xml");
      const sheet = execFileSync("unzip", ["-p", f, "xl/worksheets/sheet1.xml"], { encoding: "utf-8" });
      expect(sheet).toContain("Ada");
      expect(sheet).toContain("<v>99</v>"); // number cell, not inline string
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ods places the mimetype entry first", () => {
    const buf = buildOds([{ name: "S", rows: [["x", 1]] }]);
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
    // The first local entry's filename begins at offset 30.
    const firstName = buf.subarray(30, 30 + "mimetype".length).toString("latin1");
    expect(firstName).toBe("mimetype");
  });

  it("round-trips CSV rows", () => {
    expect(rowsToCsv([["a", "b,c"], [1, 2]])).toBe('a,"b,c"\n1,2');
    expect(csvToRows("a,b\n1,2")).toEqual([["a", "b"], [1, 2]]);
  });
});

describe("spreadsheet tools", () => {
  let dir: string;
  let ctx: ToolExecutionContext;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mm-ss-"));
    ctx = { projectRoot: dir, workspaceRoots: [dir] } as ToolExecutionContext;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("createXlsx writes a valid workbook", async () => {
    await createXlsxTool.execute({ path: "out", rows: [["a", 1]], sheetName: "Sheet1" }, ctx);
    expect(existsSync(join(dir, "out.xlsx"))).toBe(true);
    expect(readFileSync(join(dir, "out.xlsx")).subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("createOds and createCsv write their formats", async () => {
    await createOdsTool.execute({ path: "out.ods", rows: [["a", 1]], sheetName: "S" }, ctx);
    await createCsvTool.execute({ path: "out.csv", rows: [["a", 1], ["b", 2]] }, ctx);
    expect(readFileSync(join(dir, "out.ods")).subarray(0, 2).toString("latin1")).toBe("PK");
    expect(readFileSync(join(dir, "out.csv"), "utf-8")).toBe("a,1\nb,2");
  });

  it("writeDocument builds .xlsx from CSV content", async () => {
    await writeDocumentTool.execute(
      { path: "grid.xlsx", content: "h1,h2\n10,20", title: "X", contentIsHtml: false },
      ctx,
    );
    expect(readFileSync(join(dir, "grid.xlsx")).subarray(0, 2).toString("latin1")).toBe("PK");
  });
});
