export class McpClient {
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

export class McpServer {
  private running = false;

  async start(): Promise<void> {
    this.running = true;
  }
}
