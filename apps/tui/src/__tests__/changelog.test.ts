import { describe, it, expect } from "vitest";
// @ts-expect-error — plain ESM build script, no types
import { buildChangelog } from "../../../../scripts/changelog.mjs";

describe("buildChangelog (#216)", () => {
  it("groups Conventional Commits by type and buckets the rest under Other", () => {
    const out: string = buildChangelog([
      "feat: add thing (#1)",
      "fix(core): correct bug",
      "feat!: breaking change",
      "chore: bump deps",
      "random commit without a type",
    ]);
    expect(out).toContain("### Features");
    expect(out).toContain("- add thing (#1)");
    expect(out).toContain("- breaking change");
    expect(out).toContain("### Fixes");
    expect(out).toContain("- correct bug");
    expect(out).toContain("### Chores");
    expect(out).toContain("### Other");
    expect(out).toContain("- random commit without a type");
  });

  it("handles an empty changeset", () => {
    expect(buildChangelog([])).toContain("No notable changes");
  });
});
