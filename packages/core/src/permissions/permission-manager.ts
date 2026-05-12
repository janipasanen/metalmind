export class PermissionManager {
  allowReadFiles: boolean | "ask" = true;
  allowWriteFiles: boolean | "ask" = "ask";
  allowDeleteFiles: boolean | "ask" = "ask";
  allowShellCommands: boolean | "ask" = "ask";
  allowGitCommit: boolean | "ask" = "ask";

  needsConfirmation(action: string): boolean {
    const setting = this[action as keyof PermissionManager] ?? "ask";
    return setting === "ask";
  }

  isAllowed(action: string): boolean {
    const setting = this[action as keyof PermissionManager] ?? false;
    return setting === true;
  }

  isBlocked(action: string): boolean {
    const setting = this[action as keyof PermissionManager];
    return setting === false;
  }
}
