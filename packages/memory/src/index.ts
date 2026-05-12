export class SessionStore {
  private sessions = new Map<string, unknown[]>();

  async save(sessionId: string, messages: unknown[]): Promise<void> {
    this.sessions.set(sessionId, [...messages]);
  }

  async load(sessionId: string): Promise<unknown[]> {
    return this.sessions.get(sessionId) ?? [];
  }

  async list(): Promise<string[]> {
    return [...this.sessions.keys()];
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
