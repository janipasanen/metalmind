import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";

/** Same override as XDG_CONFIG_DIR (#415) — keep themes beside the config. */
const CONFIG_ROOT = process.env.METALMIND_CONFIG_DIR?.trim() || join(homedir(), ".config", "metalmind");
export const THEME_DIR = join(CONFIG_ROOT, "themes");
export const THEME_FILE = join(CONFIG_ROOT, "theme.json");

export interface Theme {
  id: string;
  name: string;
  type: "light" | "dark";
  colors: {
    background: string;
    foreground: string;
    accent: string;
    text: string;
    border: string;
  };
}

export const themes: Theme[] = [
  {
    id: "light",
    name: "Light",
    type: "light",
    colors: {
      background: "#ffffff",
      foreground: "#f0f0f0",
      accent: "#4ade80",
      text: "#1f2937",
      border: "#e5e7eb",
    },
  },
  {
    id: "dark",
    name: "Dark",
    type: "dark",
    colors: {
      background: "#1a1b26",
      foreground: "#24283b",
      accent: "#7aa2f7",
      text: "#c0caf5",
      border: "#565f89",
    },
  },
  {
    id: "one-dark",
    name: "One Dark",
    type: "dark",
    colors: {
      background: "#282c34",
      foreground: "#2d313c",
      accent: "#61afef",
      text: "#abb2bf",
      border: "#3e4451",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    type: "dark",
    colors: {
      background: "#282a36",
      foreground: "#44475a",
      accent: "#ff79c6",
      text: "#f8f8f2",
      border: "#44475a",
    },
  },
  {
    id: "catppuccin",
    name: "Catppuccin Mocha",
    type: "dark",
    colors: {
      background: "#1e1e2e",
      foreground: "#313244",
      accent: "#89b4fa",
      text: "#cdd6f4",
      border: "#45475a",
    },
  },
];

export function ensureThemeDir(): void {
  if (!existsSync(THEME_DIR)) {
    mkdirSync(THEME_DIR, { recursive: true });
  }
}

export function loadTheme(): Theme {
  ensureThemeDir();
  
  if (!existsSync(THEME_FILE)) {
    saveTheme(themes[0]);
    return themes[0];
  }
  
  try {
    const raw = readFileSync(THEME_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...themes[0], ...parsed };
  } catch {
    return themes[0];
  }
}

export function saveTheme(theme: Theme): void {
  ensureThemeDir();
  writeFileSync(THEME_FILE, JSON.stringify(theme, null, 2), "utf-8");
}

export function switchTheme(themeId: string): Theme {
  const theme = themes.find((t) => t.id === themeId) || themes[0];
  saveTheme(theme);
  return theme;
}

export function getTheme(themeId?: string): Theme {
  return themes.find((t) => t.id === themeId) || loadTheme();
}
