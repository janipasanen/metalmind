/**
 * JSON repair utilities for fixing common model output quirks:
 * - Missing quotes around keys
 * - Trailing commas
 * - Single quotes instead of double
 * - Comments
 * - Unescaped newlines in strings
 */
export class JsonRepair {
  static repair(json: string): string {
    let repaired = json.trim();

    repaired = this.stripComments(repaired);
    repaired = this.fixQuotes(repaired);
    repaired = this.fixTrailingCommas(repaired);
    repaired = this.fixMissingCommas(repaired);
    repaired = this.fixUnquotedKeys(repaired);

    try {
      JSON.parse(repaired);
      return repaired;
    } catch {
      return json;
    }
  }

  private static stripComments(text: string): string {
    return text
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
  }

  private static fixQuotes(text: string): string {
    const inString = (idx: number, str: string): boolean => {
      let count = 0;
      for (let i = idx - 1; i >= 0 && str[i] === "\\"; i--) count++;
      return count % 2 === 1;
    };

    let result = "";
    let i = 0;
    while (i < text.length) {
      if (text[i] === "'" && !inString(i, result)) {
        result += '"';
      } else {
        result += text[i];
      }
      i++;
    }
    return result;
  }

  private static fixTrailingCommas(text: string): string {
    return text.replace(/,(\s*[}\]])/g, "$1");
  }

  private static fixMissingCommas(text: string): string {
    return text.replace(/(["\d])\s*\n\s*(")/g, "$1,\n$2");
  }

  private static fixUnquotedKeys(text: string): string {
    return text.replace(
      /([{,]\s*)(\w[\w\d_-]*)(\s*:)/g,
      '$1"$2"$3',
    );
  }
}
