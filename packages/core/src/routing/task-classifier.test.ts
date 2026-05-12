import { describe, it, expect } from "vitest";
import { TaskClassifier } from "./task-classifier.js";

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
});
