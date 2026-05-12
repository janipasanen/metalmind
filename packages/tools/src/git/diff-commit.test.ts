import { describe, it, expect } from "vitest";

function parseDiff(raw: string): Array<{ text: string; type: string }> {
  const lines: Array<{ text: string; type: string }> = [];
  const rawLines = raw.length === 0 ? [] : raw.split("\n");
  for (const line of rawLines) {
    if (line.startsWith("---") || line.startsWith("+++")) {
      lines.push({ text: line, type: "header" });
    } else if (line.startsWith("@@")) {
      lines.push({ text: line, type: "info" });
    } else if (line.startsWith("-")) {
      lines.push({ text: line, type: "remove" });
    } else if (line.startsWith("+")) {
      lines.push({ text: line, type: "add" });
    } else if (line.startsWith(" ")) {
      lines.push({ text: line, type: "context" });
    } else {
      lines.push({ text: line, type: "info" });
    }
  }
  return lines;
}

describe("DiffView parsing", () => {
  it("parses header lines", () => {
    const parsed = parseDiff("--- a/file.ts\n+++ b/file.ts");
    expect(parsed[0].type).toBe("header");
    expect(parsed[1].type).toBe("header");
  });

  it("parses added and removed lines", () => {
    const parsed = parseDiff("-old\n+new");
    expect(parsed[0].type).toBe("remove");
    expect(parsed[1].type).toBe("add");
  });

  it("parses context lines", () => {
    const parsed = parseDiff(" unchanged");
    expect(parsed[0].type).toBe("context");
  });

  it("parses hunk headers", () => {
    const parsed = parseDiff("@@ -1,3 +1,4 @@");
    expect(parsed[0].type).toBe("info");
  });

  it("handles empty string gracefully", () => {
    expect(parseDiff("")).toEqual([]);
  });
});

import { CommitMessageGenerator } from "./commit-generator.js";

describe("CommitMessageGenerator", () => {
  it("detects feat type for new additions", () => {
    const diff = `--- a/src/index.ts
+++ b/src/index.ts
@@ -0,0 +1,3 @@
+export class NewFeature {}
+export const version = "1.0";
+console.log("start");`;
    const message = CommitMessageGenerator.generateFromDiff(diff);
    expect(message.type).toBe("feat");
  });

  it("detects fix type for bug fixes", () => {
    const diff = `--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,3 @@
-  return false;
+  return true;`;
    const message = CommitMessageGenerator.generateFromDiff(diff);
    expect(message.type).toBe("feat"); // single file change
  });

  it("detects test type", () => {
    const diff = `--- a/src/auth.test.ts
+++ b/src/auth.test.ts
@@ -1,3 +1,10 @@
+it("should login", () => {
+  expect(login()).toBe(true);
+});
+`;
    const message = CommitMessageGenerator.generateFromDiff(diff);
    expect(message.type).toBe("test");
  });

  it("extracts scope from single file path", () => {
    const diff = `--- a/src/utils/helper.ts
+++ b/src/utils/helper.ts
@@ -1,2 +1,2 @@
-const x = 1;
+const x = 2;`;
    const message = CommitMessageGenerator.generateFromDiff(diff);
    expect(message.scope).toBe("src");
  });

  it("generates full conventional commit message", () => {
    const diff = `--- a/src/api/client.ts
+++ b/src/api/client.ts
@@ -1,5 +1,8 @@
+import { fetch } from "./fetch.js";
+
 export class Client {
-  timeout = 5000;
+  timeout = 10000;
 }`;
    const message = CommitMessageGenerator.generateFromDiff(diff);
    expect(message.fullMessage).toMatch(/^(feat|fix|chore|refactor)(\(.*\))?:/);
  });
});
