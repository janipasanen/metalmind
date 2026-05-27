import { describe, it, expect } from "vitest";
import { TaskClassifier, countFileReferences } from "./task-classifier.js";
import { estimateTokens, CostTracker } from "./cost-tracker.js";

describe("TaskClassifier", () => {
  const classifier = new TaskClassifier();

  it("routes read/explain tasks to tier1", () => {
    const result = classifier.classify("read the file src/auth.ts");
    expect(result.tier).toBe("tier1-local");
  });

  it("routes search tasks to tier1", () => {
    const result = classifier.classify("search for authentication implementation");
    expect(result.tier).toBe("tier1-local");
  });

  it("routes summarize to tier1", () => {
    const result = classifier.classify("summarize the changes in this repo");
    expect(result.tier).toBe("tier1-local");
  });

  it("routes architecture tasks to tier3", () => {
    const result = classifier.classify("design the authentication architecture");
    expect(result.tier).toBe("tier3-cloud");
  });

  it("routes refactor tasks to tier3", () => {
    const result = classifier.classify("refactor the entire auth service");
    expect(result.tier).toBe("tier3-cloud");
  });

  it("routes multi-step tasks to tier3", () => {
    const result = classifier.classify("read the auth service then refactor the login flow and also update the tests");
    expect(result.tier).toBe("tier3-cloud");
  });

  it("routes simple edit tasks to tier2", () => {
    const result = classifier.classify("edit the timeout in auth.ts");
    expect(result.tier).toBe("tier2-medium");
  });

  it("routes fix tasks to tier2", () => {
    const result = classifier.classify("fix the login bug");
    expect(result.tier).toBe("tier2-medium");
  });

  it("routes deploy tasks to tier3", () => {
    const result = classifier.classify("update the CI/CD pipeline for deployment");
    expect(result.tier).toBe("tier3-cloud");
  });

  it("provides reasoning and confidence", () => {
    const result = classifier.classify("find where auth is implemented");
    expect(result.reasoning).toBeTruthy();
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("defaults unknown tasks to tier1", () => {
    const result = classifier.classify("hmm let's see what happens");
    expect(result.tier).toBe("tier1-local");
  });

  it("routes a multi-file edit (≥2 real files) to tier3", () => {
    const result = classifier.classify("update App.tsx, agent.ts and config.ts");
    expect(result.tier).toBe("tier3-cloud");
  });

  it("does not over-count a single file mentioned repeatedly", () => {
    const result = classifier.classify("edit the timeout in auth.ts");
    expect(result.tier).toBe("tier2-medium");
  });
});

describe("countFileReferences", () => {
  it("counts distinct file paths with extensions", () => {
    expect(countFileReferences("update App.tsx, agent.ts and config.ts")).toBe(3);
  });

  it("counts a path-qualified file", () => {
    expect(countFileReferences("read src/auth/login.ts")).toBe(1);
  });

  it("returns 0 when only the word 'file' appears (the old bug)", () => {
    expect(countFileReferences("open the file, read the file, edit the file")).toBe(0);
  });

  it("de-duplicates the same file mentioned twice", () => {
    expect(countFileReferences("open auth.ts then re-open auth.ts")).toBe(1);
  });

  it("ignores abbreviations like e.g", () => {
    expect(countFileReferences("do something, e.g. quickly")).toBe(0);
  });
});

describe("token estimate consistency", () => {
  it("classifier and CostTracker agree on token estimates", () => {
    const text = "a".repeat(400);
    const tracker = new CostTracker();
    expect(estimateTokens(text)).toBe(tracker.estimateTokens(text));
    expect(estimateTokens(text)).toBe(100);
  });
});
