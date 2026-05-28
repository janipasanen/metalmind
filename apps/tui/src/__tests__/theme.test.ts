import { describe, it, expect } from "vitest";
import { switchTheme, loadTheme, themes } from "@metalmind/config";

describe("Theme System", () => {
  it("has theme definitions", () => {
    expect(themes).toBeDefined();
    expect(themes.length).toBeGreaterThan(0);
  });

  it("can load current theme", () => {
    const theme = loadTheme();
    expect(theme).toBeDefined();
    expect(theme.id).toBeDefined();
    expect(theme.name).toBeDefined();
    expect(theme.type).toBeDefined();
  });

  it("can switch to light theme", () => {
    const theme = switchTheme("light");
    expect(theme.id).toBe("light");
    expect(theme.type).toBe("light");
  });

  it("can switch to dark theme", () => {
    const theme = switchTheme("dark");
    expect(theme.id).toBe("dark");
    expect(theme.type).toBe("dark");
  });

  it("can switch to one-dark theme", () => {
    const theme = switchTheme("one-dark");
    expect(theme.id).toBe("one-dark");
  });

  it("can switch to dracula theme", () => {
    const theme = switchTheme("dracula");
    expect(theme.id).toBe("dracula");
  });

  it("can switch to catppuccin theme", () => {
    const theme = switchTheme("catppuccin");
    expect(theme.id).toBe("catppuccin");
  });

  it("theme persists in config", () => {
    const themeId = "dark";
    switchTheme(themeId);
    const loaded = loadTheme();
    expect(loaded.id).toBe(themeId);
  });
});
