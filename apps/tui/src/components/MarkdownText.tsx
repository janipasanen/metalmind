import React from "react";
import { Box, Text } from "ink";
import { highlightLine } from "../highlight.js";

interface Props {
  text: string;
  accent?: string;
}

interface Segment {
  text: string;
  bold?: boolean;
  code?: boolean;
  link?: boolean;
  dim?: boolean;
  italic?: boolean;
}

function parseInline(raw: string, accent: string): React.ReactNode {
  const segments: Segment[] = [];
  let s = raw;
  while (s.length > 0) {
    const bold = s.match(/\*\*(.*?)\*\*/);
    const code = s.match(/`([^`\n]+)`/);
    // [text](url) links (#354): label in accent, target shown dim after it.
    const link = s.match(/\[([^\]]+)\]\(([^)\s]+)\)/);
    // *italic* (#354) — single-asterisk only; underscores are too common in
    // identifiers to treat as emphasis. Bold sorts first at the same region
    // because `**` matches one index earlier than the inner `*`.
    const italic = s.match(/\*([^*\n]+)\*/);

    const candidates = [
      bold ? { idx: bold.index!, len: bold[0].length, content: bold[1], type: "bold", extra: "" } : null,
      code ? { idx: code.index!, len: code[0].length, content: code[1], type: "code", extra: "" } : null,
      link ? { idx: link.index!, len: link[0].length, content: link[1], type: "link", extra: link[2] } : null,
      italic ? { idx: italic.index!, len: italic[0].length, content: italic[1], type: "italic", extra: "" } : null,
    ]
      .filter(Boolean)
      .sort((a, b) => a!.idx - b!.idx) as Array<{ idx: number; len: number; content: string; type: string; extra: string }>;

    if (candidates.length === 0) {
      segments.push({ text: s });
      break;
    }

    const first = candidates[0];
    if (first.idx > 0) segments.push({ text: s.slice(0, first.idx) });
    if (first.type === "bold") segments.push({ text: first.content, bold: true });
    if (first.type === "code") segments.push({ text: first.content, code: true });
    if (first.type === "italic") segments.push({ text: first.content, italic: true });
    if (first.type === "link") {
      segments.push({ text: first.content, link: true });
      segments.push({ text: ` (${first.extra})`, dim: true });
    }
    s = s.slice(first.idx + first.len);
  }

  if (segments.length === 0) return <Text>{raw}</Text>;

  // ONE <Text> parent wrapping the styled spans (#400). Returning a fragment of
  // sibling <Text> elements made Ink lay each span out as its own FLEX ITEM
  // inside the parent <Box>: every formatted line was shattered into staggered
  // columns and individual characters were dropped at the wrap points. Nested
  // <Text> is inline, so the line flows and wraps as a single run of text.
  return (
    <Text>
      {segments.map((seg, i) => {
        if (seg.code) return <Text key={i} color="green">{seg.text}</Text>;
        if (seg.bold) return <Text key={i} bold>{seg.text}</Text>;
        if (seg.link) return <Text key={i} color={accent} underline>{seg.text}</Text>;
        if (seg.dim) return <Text key={i} dimColor>{seg.text}</Text>;
        if (seg.italic) return <Text key={i} italic>{seg.text}</Text>;
        return <Text key={i}>{seg.text}</Text>;
      })}
    </Text>
  );
}

const TABLE_LINE = /^\s*\|.*\|\s*$/;
const MAX_CELL = 28;

function splitCells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** GitHub-style table block rendered with aligned, truncated columns (#354). */
function TableBlock({ rows, accent }: { rows: string[]; accent: string }) {
  const parsed = rows.map(splitCells);
  const isSep = (cells: string[]) => cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "");
  const body = parsed.filter((c) => !isSep(c));
  if (body.length === 0) return <Text dimColor>{rows.join("\n")}</Text>;
  const headerIdx = parsed.length > 1 && isSep(parsed[1]) ? 0 : -1;
  const cols = Math.max(...body.map((c) => c.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    widths.push(Math.min(MAX_CELL, Math.max(...body.map((r) => (r[c] ?? "").length), 1)));
  }
  const fmt = (cells: string[]) =>
    widths
      .map((w, c) => {
        const cell = cells[c] ?? "";
        return (cell.length > w ? cell.slice(0, w - 1) + "…" : cell.padEnd(w));
      })
      .join(" │ ");
  return (
    <Box flexDirection="column">
      {body.map((cells, r) => (
        <Text key={r} bold={headerIdx === 0 && r === 0} color={headerIdx === 0 && r === 0 ? accent : undefined}>
          {fmt(cells)}
        </Text>
      ))}
    </Box>
  );
}

export default function MarkdownText({ text, accent = "cyan" }: Props) {
  const lines = text.split("\n");

  // Track fenced code-block state so lines inside a block get syntax highlighting (#171).
  let inCode = false;
  let codeLang = "";

  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block marker — toggle state and capture the language.
    if (line.startsWith("```")) {
      if (!inCode) { inCode = true; codeLang = line.slice(3).trim(); }
      else { inCode = false; codeLang = ""; }
      nodes.push(<Text key={i} dimColor>{line}</Text>);
      continue;
    }

    // Inside a fenced block: render with syntax highlighting.
    if (inCode) {
      const spans = highlightLine(line, codeLang);
      nodes.push(
        <Text key={i}>
          {spans.map((s, j) => <Text key={j} color={s.color}>{s.text}</Text>)}
        </Text>,
      );
      continue;
    }

    // Table block (#354): consume consecutive |…| lines and align columns.
    if (TABLE_LINE.test(line)) {
      const block: string[] = [];
      let j = i;
      while (j < lines.length && TABLE_LINE.test(lines[j])) { block.push(lines[j]); j++; }
      nodes.push(<TableBlock key={i} rows={block} accent={accent} />);
      i = j - 1;
      continue;
    }

    // H1 / H2
    if (/^#{1,2}\s/.test(line)) {
      const content = line.replace(/^#{1,2}\s+/, "");
      nodes.push(
        <Box key={i} marginTop={i > 0 ? 1 : 0}>
          <Text bold color={accent}>{content}</Text>
        </Box>,
      );
      continue;
    }

    // H3 / H4
    if (/^#{3,4}\s/.test(line)) {
      const content = line.replace(/^#{3,6}\s+/, "");
      nodes.push(
        <Box key={i} marginTop={i > 0 ? 1 : 0}>
          <Text bold underline>{content}</Text>
        </Box>,
      );
      continue;
    }

    // Bullet list: "- item", "* item", "•  item" — indentation nests (#354).
    const bullet = line.match(/^(\s*)[-*•]\s+(.*)/);
    if (bullet) {
      const depth = Math.min(4, Math.floor(bullet[1].length / 2));
      nodes.push(
        <Box key={i} flexDirection="row" marginLeft={depth * 2}>
          <Text color={accent}>{depth > 0 ? "◦ " : "• "}</Text>
          <Box flexGrow={1}>{parseInline(bullet[2], accent)}</Box>
        </Box>,
      );
      continue;
    }

    // Numbered list: "1. item" — indentation nests (#354).
    const numMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/);
    if (numMatch) {
      const depth = Math.min(4, Math.floor(numMatch[1].length / 2));
      nodes.push(
        <Box key={i} flexDirection="row" marginLeft={depth * 2}>
          <Text color={accent}>{numMatch[2]}. </Text>
          <Box flexGrow={1}>{parseInline(numMatch[3], accent)}</Box>
        </Box>,
      );
      continue;
    }

    // Blockquote (#354): "> quoted text" with a gutter bar.
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      nodes.push(
        <Box key={i} flexDirection="row">
          <Text dimColor>▎ </Text>
          <Box flexGrow={1}>{parseInline(quote[1], accent)}</Box>
        </Box>,
      );
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      nodes.push(<Text key={i} dimColor>──────────────────────</Text>);
      continue;
    }

    // Empty line → small gap
    if (line.trim() === "") {
      nodes.push(<Text key={i}>{" "}</Text>);
      continue;
    }

    // Normal paragraph line
    nodes.push(<Box key={i}>{parseInline(line, accent)}</Box>);
  }

  return <Box flexDirection="column">{nodes}</Box>;
}
