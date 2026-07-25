import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point HOME at a unique per-worker temp dir BEFORE any module computes
// XDG_CONFIG_DIR (= join(homedir(), ".config", "metalmind")). The TUI tests read
// and write the XDG config heavily; without isolation they share the developer's
// real ~/.config/metalmind/config.json and race across parallel test files,
// causing intermittent routing/approval failures. os.homedir() honours $HOME on
// POSIX, so setting it here gives each worker a throwaway config.
const home = mkdtempSync(join(tmpdir(), "mm-tui-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
