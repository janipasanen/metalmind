import { notifications as bridge } from "./macos-bridge.js";

export type NotificationEvent =
  | "task-complete"
  | "task-error"
  | "approval-needed"
  | "model-fallback"
  | "long-running-start";

export interface NotificationPreferences {
  enabled: boolean;
  events: Partial<Record<NotificationEvent, boolean>>;
}

const defaultPreferences: NotificationPreferences = {
  enabled: true,
  events: {
    "task-complete": true,
    "task-error": true,
    "approval-needed": true,
    "model-fallback": true,
    "long-running-start": false,
  },
};

/**
 * macOS native notification service with configurable preferences.
 */
export class NotificationService {
  private prefs: NotificationPreferences;

  constructor(prefs: Partial<NotificationPreferences> = {}) {
    this.prefs = { ...defaultPreferences, ...prefs };
  }

  /**
   * Update notification preferences.
   */
  setPreferences(prefs: Partial<NotificationPreferences>): void {
    this.prefs = { ...this.prefs, ...prefs };
  }

  /**
   * Send a notification for an event type if enabled.
   */
  async notify(
    event: NotificationEvent,
    title: string,
    body: string,
  ): Promise<void> {
    if (!this.prefs.enabled) return;

    const eventEnabled = this.prefs.events[event];
    if (eventEnabled === false) return;

    try {
      await bridge.send(title, body);
    } catch {
      // Notifications are best-effort — never throw
    }
  }

  /**
   * Notify that a long-running task has completed.
   */
  async taskComplete(taskDescription: string): Promise<void> {
    await this.notify(
      "task-complete",
      "MetalMind — Task Complete",
      taskDescription,
    );
  }

  /**
   * Notify about a task error.
   */
  async taskError(errorMessage: string): Promise<void> {
    await this.notify(
      "task-error",
      "MetalMind — Error",
      errorMessage,
    );
  }

  /**
   * Notify that user approval is needed.
   */
  async approvalNeeded(operation: string): Promise<void> {
    await this.notify(
      "approval-needed",
      "MetalMind — Approval Required",
      `Approve: ${operation}`,
    );
  }

  /**
   * Notify about model fallback (e.g., local model failed, using cloud).
   */
  async modelFallback(fromModel: string, toModel: string): Promise<void> {
    await this.notify(
      "model-fallback",
      "MetalMind — Model Fallback",
      `Falling back from ${fromModel} to ${toModel}`,
    );
  }

  /**
   * Notify that a long-running operation has started.
   */
  async longRunningStarted(taskDescription: string): Promise<void> {
    await this.notify(
      "long-running-start",
      "MetalMind — Started",
      taskDescription,
    );
  }
}
