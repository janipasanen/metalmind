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
  accent?: boolean;
}

function parseInline(raw: string, accent: string): React.ReactNode {
  const segments: Segment[] = [];
  let s = raw;
  while (s.length > 0) {
    const bold = s.match(/\*\*(.*?)\*\*/);
    const code = s.match(/`([^`\n]+)`/);

    const candidates = [
      bold ? { idx: bold.index!, len: bold[0].length, content: bold[1], type: "bold" } : null,
      code ? { idx: code.index!, len: code[0].length, content: code[1], type: "code" } : null,
    ]
      .filter(Boolean)
      .sort((a, b) => a!.idx - b!.idx) as Array<{ idx: number; len: number; content: string; type: string }>;

    if (candidates.length === 0) {
      segments.push({ text: s });
      break;
    }

    const first = candidates[0];
    if (first.idx > 0) segments.push({ text: s.slice(0, first.idx) });
    if (first.type === "bold") segments.push({ text: first.content, bold: true });
    if (first.type === "code") segments.push({ text: first.content, code: true });
    s = s.slice(first.idx + first.len);
  }

  if (segments.length === 0) return <Text>{raw}</Text>;

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.code) return <Text key={i} color="green">{seg.text}</Text>;
        if (seg.bold) return <Text key={i} bold>{seg.text}</Text>;
        return <Text key={i}>{seg.text}</Text>;
      })}
    </>
  );
}

export default function MarkdownText({ text, accent = "cyan" }: Props) {
  const lines = text.split("\n");

  // Track fenced code-block state so lines inside a block get syntax highlighting (#171).
  let inCode = false;
  let codeLang = "";

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        // Fenced code block marker — toggle state and capture the language.
        if (line.startsWith("```")) {
          if (!inCode) { inCode = true; codeLang = line.slice(3).trim(); }
          else { inCode = false; codeLang = ""; }
          return <Text key={i} dimColor>{line}</Text>;
        }

        // Inside a fenced block: render with syntax highlighting.
        if (inCode) {
          const spans = highlightLine(line, codeLang);
          return (
            <Text key={i}>
              {spans.map((s, j) => <Text key={j} color={s.color}>{s.text}</Text>)}
            </Text>
          );
        }

        // H1 / H2
        if (/^#{1,2}\s/.test(line)) {
          const content = line.replace(/^#{1,2}\s+/, "");
          return (
            <Box key={i} marginTop={i > 0 ? 1 : 0}>
              <Text bold color={accent}>{content}</Text>
            </Box>
          );
        }

        // H3 / H4
        if (/^#{3,4}\s/.test(line)) {
          const content = line.replace(/^#{3,6}\s+/, "");
          return (
            <Box key={i} marginTop={i > 0 ? 1 : 0}>
              <Text bold underline>{content}</Text>
            </Box>
          );
        }

        // Bullet list: "- item", "* item", "•  item"
        if (/^[-*•]\s+/.test(line)) {
          const content = line.replace(/^[-*•]\s+/, "");
          return (
            <Box key={i} flexDirection="row">
              <Text color={accent}>• </Text>
              <Box flexGrow={1}>{parseInline(content, accent)}</Box>
            </Box>
          );
        }

        // Numbered list: "1. item"
        const numMatch = line.match(/^(\d+)\.\s+(.*)/);
        if (numMatch) {
          return (
            <Box key={i} flexDirection="row">
              <Text color={accent}>{numMatch[1]}. </Text>
              <Box flexGrow={1}>{parseInline(numMatch[2], accent)}</Box>
            </Box>
          );
        }

        // Horizontal rule
        if (/^---+$/.test(line.trim())) {
          return <Text key={i} dimColor>──────────────────────</Text>;
        }

        // Empty line → small gap
        if (line.trim() === "") {
          return <Text key={i}>{" "}</Text>;
        }

        // Normal paragraph line
        return <Box key={i}>{parseInline(line, accent)}</Box>;
      })}
    </Box>
  );
}
