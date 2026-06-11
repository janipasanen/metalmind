/**
 * Lightweight, dependency-free syntax highlighting for fenced code blocks (#171).
 * Tokenizes a line into colored spans — strings, comments, numbers, and language
 * keywords. Not a full parser; a fast, good-enough TUI highlighter.
 */

export interface Span {
  text: string;
  color?: string;
}

const KEYWORDS: Record<string, string[]> = {
  ts: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "import", "export", "from", "default", "class", "interface", "type", "enum", "extends", "implements", "async", "await", "new", "try", "catch", "finally", "throw", "typeof", "instanceof", "public", "private", "protected", "readonly", "static", "this", "super", "null", "undefined", "true", "false", "void", "yield"],
  py: ["def", "return", "if", "elif", "else", "for", "while", "import", "from", "as", "class", "async", "await", "lambda", "with", "try", "except", "finally", "raise", "pass", "break", "continue", "yield", "global", "nonlocal", "None", "True", "False", "and", "or", "not", "in", "is", "self"],
  go: ["func", "return", "if", "else", "for", "range", "import", "package", "var", "const", "type", "struct", "interface", "map", "chan", "go", "defer", "select", "switch", "case", "break", "continue", "nil", "true", "false"],
  rust: ["fn", "let", "mut", "return", "if", "else", "for", "while", "loop", "match", "impl", "struct", "enum", "trait", "use", "mod", "pub", "async", "await", "move", "ref", "self", "Self", "true", "false", "None", "Some", "Ok", "Err"],
};

function normalizeLang(lang: string): string {
  const l = lang.toLowerCase().trim();
  if (l === "typescript" || l === "tsx" || l === "javascript" || l === "js" || l === "jsx") return "ts";
  if (l === "python") return "py";
  if (l === "golang") return "go";
  return l;
}

export function highlightLine(line: string, lang: string): Span[] {
  const key = normalizeLang(lang);
  const kw = new Set(KEYWORDS[key] ?? KEYWORDS.ts);
  const commentPat = key === "py" ? "#[^\\n]*" : "\\/\\/[^\\n]*";
  const tokenRe = new RegExp(
    `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`|${commentPat}|\\b\\d+(?:\\.\\d+)?\\b|[A-Za-z_$][\\w$]*|\\s+|.)`,
    "g",
  );
  const spans: Span[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(line)) !== null) {
    const t = m[0];
    if (/^["'`]/.test(t)) spans.push({ text: t, color: "yellow" });
    else if (t.startsWith("//") || (key === "py" && t.startsWith("#"))) spans.push({ text: t, color: "gray" });
    else if (/^\d/.test(t)) spans.push({ text: t, color: "magenta" });
    else if (kw.has(t)) spans.push({ text: t, color: "blueBright" });
    else spans.push({ text: t });
    if (m.index === tokenRe.lastIndex) tokenRe.lastIndex++; // guard against zero-width
  }
  return spans;
}
