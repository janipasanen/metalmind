export class RepoMap {
  private root: string;

  constructor(root: string) {
    this.root = root;
  }

  getRoot(): string {
    return this.root;
  }
}

export class TokenBudget {
  countTokens(text: string): number {
    return text.length / 4;
  }
}
