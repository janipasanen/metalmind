import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";

export interface SymbolInfo {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "export" | "import" | "variable" | "enum";
  range: { startRow: number; startColumn: number; endRow: number; endColumn: number };
  parent?: string;
  exported: boolean;
  modifiers: string[];
}

export interface ImportInfo {
  source: string;
  names: string[];
  isDefault: boolean;
  namespace?: string;
}

export interface ParseResult {
  symbols: SymbolInfo[];
  imports: ImportInfo[];
  errors: string[];
}

function parseTypeScript(): Parser {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  return parser;
}

/**
 * Extract code structure from TypeScript/JavaScript source using Tree-sitter.
 */
export function parseSource(source: string, filePath?: string): ParseResult {
  const parser = parseTypeScript();
  const tree = parser.parse(source);
  const rootNode = tree.rootNode;

  const symbols: SymbolInfo[] = [];
  const imports: ImportInfo[] = [];
  const errors: string[] = [];

  if (rootNode.hasError) {
    // Collect error nodes
    collectErrors(rootNode, errors);
  }

  walkTree(rootNode, symbols, imports);

  return { symbols, imports, errors };
}

function collectErrors(node: Parser.SyntaxNode, errors: string[]): void {
  if (node.isError || node.isMissing) {
    errors.push(
      `Parse error at ${node.startPosition.row}:${node.startPosition.column} — "${node.type}"`,
    );
  }
  for (let i = 0; i < node.childCount; i++) {
    collectErrors(node.child(i)!, errors);
  }
}

function walkTree(
  node: Parser.SyntaxNode,
  symbols: SymbolInfo[],
  imports: ImportInfo[],
  parentName?: string,
): void {
  const cursor = node.walk();

  if (cursor.gotoFirstChild()) {
    do {
      const current = cursor.currentNode;
      if (!current) continue;

      const type = current.type;

      // Function declarations
      if (type === "function_declaration") {
        const name = getChildText(current, "identifier") ?? getChildText(current, "name");
        if (name) {
          symbols.push(makeSymbol(name, "function", current, parentName));
        }
        // Walk children but not deeper into nested functions
        walkTreeChildren(current, symbols, imports, name ?? parentName);
      }
      // Arrow functions and function expressions assigned to variables
      else if (type === "lexical_declaration" || type === "variable_declaration") {
        const declarations = current.descendantsOfType(
          type === "lexical_declaration" ? "variable_declarator" : "variable_declarator",
        );
        for (const decl of declarations) {
          const name = getChildText(decl, "identifier") ?? getChildText(decl, "name");
          const value = decl.childForFieldName?.("value");
          const isArrowOrFunc =
            value?.type === "arrow_function" || value?.type === "function_expression";

          if (name) {
            symbols.push(
              makeSymbol(name, isArrowOrFunc ? "function" : "variable", decl, parentName),
            );
          }
        }
      }
      // Class declarations
      else if (type === "class_declaration") {
        const name = getChildText(current, "identifier") ?? getChildText(current, "name") ?? "anonymous";
        const exported = isExported(current);
        symbols.push({
          ...makeSymbol(name, "class", current, parentName),
          exported,
        });

        // Extract methods
        const body = current.childForFieldName?.("body");
        if (body) {
          const methods = body.descendantsOfType("method_definition");
          for (const method of methods) {
            const methodName = getChildText(method, "name");
            if (methodName && methodName !== "constructor") {
              symbols.push(makeSymbol(methodName, "function", method, name, exported));
            }
          }
        }
      }
      // Interface declarations
      else if (type === "interface_declaration") {
        const name = getChildText(current, "type_identifier") ?? getChildText(current, "name") ?? "anonymous";
        symbols.push({
          ...makeSymbol(name, "interface", current, parentName),
          exported: isExported(current),
        });
      }
      // Type alias
      else if (type === "type_alias_declaration") {
        const name = getChildText(current, "type_identifier") ?? getChildText(current, "name");
        if (name) {
          symbols.push({
            ...makeSymbol(name, "type", current, parentName),
            exported: isExported(current),
          });
        }
      }
      // Enum declarations
      else if (type === "enum_declaration") {
        const name = getChildText(current, "identifier") ?? getChildText(current, "name");
        if (name) {
          symbols.push({
            ...makeSymbol(name, "enum", current, parentName),
            exported: isExported(current),
          });
        }
      }
      // Export statements
      else if (type === "export_statement") {
        const exported = extractExport(current, symbols, imports, parentName);
        if (exported) {
          // Mark the exported symbol as exported
          const last = symbols[symbols.length - 1];
          if (last) last.exported = true;
        }
      }
      // Import statements
      else if (type === "import_statement") {
        const imp = extractImport(current);
        if (imp) imports.push(imp);
      }
      else {
        // Recurse into other nodes
        walkTreeChildren(current, symbols, imports, parentName);
      }
    } while (cursor.gotoNextSibling());
  }
}

function walkTreeChildren(
  node: Parser.SyntaxNode,
  symbols: SymbolInfo[],
  imports: ImportInfo[],
  parentName?: string,
): void {
  for (let i = 0; i < node.childCount; i++) {
    walkTree(node.child(i)!, symbols, imports, parentName);
  }
}

function makeSymbol(
  name: string,
  kind: SymbolInfo["kind"],
  node: Parser.SyntaxNode,
  parent?: string,
  exported?: boolean,
): SymbolInfo {
  return {
    name,
    kind,
    range: {
      startRow: node.startPosition.row,
      startColumn: node.startPosition.column,
      endRow: node.endPosition.row,
      endColumn: node.endPosition.column,
    },
    parent,
    exported: exported ?? false,
    modifiers: [],
  };
}

function getChildText(node: Parser.SyntaxNode, fieldName: string): string | undefined {
  const child = node.childForFieldName?.(fieldName);
  return child?.text;
}

function isExported(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;

  // Check if parent is an export statement
  if (parent.type === "export_statement") return true;

  // Check if there's an export modifier
  const modifiers = node.children.filter((c) => c.type === "export");
  return modifiers.length > 0;
}

function extractExport(
  node: Parser.SyntaxNode,
  symbols: SymbolInfo[],
  imports: ImportInfo[],
  parentName?: string,
): boolean {
  const declaration = node.childForFieldName?.("declaration");
  if (!declaration) return false;

  const name = declaration.childForFieldName?.("name")?.text;
  if (name) {
    const kind: SymbolInfo["kind"] = mapDeclarationKind(declaration.type);
    symbols.push({
      ...makeSymbol(name, kind, declaration, parentName),
      exported: true,
    });
    return true;
  }
  return false;
}

function mapDeclarationKind(type: string): SymbolInfo["kind"] {
  if (type.includes("function")) return "function";
  if (type.includes("class")) return "class";
  if (type.includes("interface")) return "interface";
  if (type.includes("type")) return "type";
  if (type.includes("enum")) return "enum";
  return "variable";
}

function extractImport(node: Parser.SyntaxNode): ImportInfo | null {
  const source = getChildText(node, "source")?.replace(/['"]/g, "");
  if (!source) return null;

  const names: string[] = [];
  let isDefault = false;
  let namespace: string | undefined;

  // Named imports
  const specifiers = node.descendantsOfType("import_specifier");
  for (const spec of specifiers) {
    const name = spec.childForFieldName?.("name")?.text;
    if (name) names.push(name);
  }

  // Default import
  const defaultSpec = node.childForFieldName?.("default");
  if (defaultSpec) {
    isDefault = true;
    names.push(defaultSpec.text);
  }

  // Namespace import
  const nsSpec = node.descendantsOfType("namespace_import");
  if (nsSpec.length > 0 && nsSpec[0]) {
    namespace = nsSpec[0].childForFieldName?.("name")?.text;
  }

  return { source, names, isDefault, namespace };
}

/**
 * Build a symbol index from parsed results for fast lookup.
 */
export class SymbolIndex {
  private byName = new Map<string, SymbolInfo[]>();
  private byKind = new Map<SymbolInfo["kind"], SymbolInfo[]>();
  private byFile = new Map<string, SymbolInfo[]>();
  private exports: SymbolInfo[] = [];

  addSymbols(filePath: string, symbols: SymbolInfo[]): void {
    // Index by file
    this.byFile.set(filePath, symbols);

    for (const sym of symbols) {
      // Index by name
      const existing = this.byName.get(sym.name) ?? [];
      existing.push(sym);
      this.byName.set(sym.name, existing);

      // Index by kind
      const kindList = this.byKind.get(sym.kind) ?? [];
      kindList.push(sym);
      this.byKind.set(sym.kind, kindList);

      // Track exports
      if (sym.exported) {
        this.exports.push(sym);
      }
    }
  }

  findByName(name: string): SymbolInfo[] {
    return this.byName.get(name) ?? [];
  }

  findByKind(kind: SymbolInfo["kind"]): SymbolInfo[] {
    return this.byKind.get(kind) ?? [];
  }

  findByFile(filePath: string): SymbolInfo[] {
    return this.byFile.get(filePath) ?? [];
  }

  getExports(): SymbolInfo[] {
    return this.exports;
  }

  getAllSymbols(): SymbolInfo[] {
    return [...this.byFile.values()].flat();
  }

  clear(): void {
    this.byName.clear();
    this.byKind.clear();
    this.byFile.clear();
    this.exports = [];
  }

  get size(): number {
    return this.getAllSymbols().length;
  }
}
