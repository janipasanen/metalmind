import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { loadXdgConfig, saveXdgConfig } from "@metalmind/config";
import type { McpServerConfig } from "@metalmind/config";

interface McpServer {
  id: string;
  name: string;
  transport: "http" | "stdio";
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  enabled: boolean;
}

interface McpConfigProps {
  onDone: () => void;
  accent?: string;
}

type HttpField = "name" | "url" | "token";
const HTTP_FIELDS: HttpField[] = ["name", "url", "token"];

type StdioField = "name" | "command" | "args";
const STDIO_FIELDS: StdioField[] = ["name", "command", "args"];

interface AddForm {
  transport: "http" | "stdio";
  name: string;
  url: string;
  token: string;
  command: string;
  args: string;
}

export default function McpConfig({ onDone, accent = "cyan" }: McpConfigProps) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [activeField, setActiveField] = useState(0);
  const [form, setForm] = useState<AddForm>({ transport: "http", name: "", url: "", token: "", command: "", args: "" });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);

  const formFields = form.transport === "http" ? HTTP_FIELDS : STDIO_FIELDS;

  useEffect(() => {
    const config = loadXdgConfig();
    const loaded = Object.entries(config.mcpServers || {}).map(([id, cfg]) => ({
      id,
      name: cfg.name || id,
      transport: cfg.url ? ("http" as const) : ("stdio" as const),
      url: cfg.url,
      headers: cfg.headers,
      command: cfg.command,
      args: cfg.args,
      enabled: cfg.enabled,
    }));
    setServers(loaded);
  }, []);

  const saveServer = () => {
    if (!form.name) return;
    if (form.transport === "http" && !form.url) return;
    if (form.transport === "stdio" && !form.command) return;

    const id = form.name.replace(/\s+/g, "-").toLowerCase();
    const newServer: McpServer = {
      id,
      name: form.name,
      transport: form.transport,
      enabled: true,
      ...(form.transport === "http"
        ? {
            url: form.url,
            headers: form.token
              ? {
                  Authorization: `Bearer ${form.token}`,
                  "x-api-key": form.token,
                }
              : undefined,
          }
        : {
            command: form.command,
            args: form.args.split(" ").filter(Boolean),
          }),
    };

    const updated = [...servers, newServer];
    const mcpServers: Record<string, McpServerConfig> = {};
    for (const s of updated) {
      mcpServers[s.id] = {
        name: s.name,
        enabled: s.enabled,
        ...(s.transport === "http" ? { url: s.url, headers: s.headers } : { command: s.command, args: s.args }),
      };
    }
    saveXdgConfig({ ...loadXdgConfig(), mcpServers });
    setServers(updated);
    setForm({ transport: "http", name: "", url: "", token: "", command: "", args: "" });
    setActiveField(0);
    setShowAddForm(false);
  };

  const deleteServer = (id: string) => {
    const updated = servers.filter((s) => s.id !== id);
    const mcpServers: Record<string, McpServerConfig> = {};
    for (const s of updated) {
      mcpServers[s.id] = {
        name: s.name,
        enabled: s.enabled,
        ...(s.transport === "http" ? { url: s.url, headers: s.headers } : { command: s.command, args: s.args }),
      };
    }
    saveXdgConfig({ ...loadXdgConfig(), mcpServers });
    setServers(updated);
    setShowDeleteConfirm(null);
    setSelectedIndex(0);
  };

  useInput((input, key) => {
    if (key.escape) {
      if (showDeleteConfirm) { setShowDeleteConfirm(null); return; }
      if (showAddForm) {
        setShowAddForm(false);
        setForm({ transport: "http", name: "", url: "", token: "", command: "", args: "" });
        setActiveField(0);
        return;
      }
      onDone();
      return;
    }

    if (showAddForm) {
      const field = formFields[activeField] as string;

      // Transport toggle with left/right on first field (name)
      if (field === "name" && (key.leftArrow || key.rightArrow)) {
        setForm((f) => ({ ...f, transport: f.transport === "http" ? "stdio" : "http" }));
        setActiveField(0);
        return;
      }

      if (key.backspace) {
        setForm((f) => ({ ...f, [field]: (f[field as keyof AddForm] as string).slice(0, -1) }));
        return;
      }
      if (input && !key.tab && !key.return) {
        setForm((f) => ({ ...f, [field]: (f[field as keyof AddForm] as string) + input }));
        return;
      }

      if (key.tab || key.return) {
        if (key.return && activeField === formFields.length - 1) {
          saveServer();
          return;
        }
        setActiveField((prev) => (prev + 1) % formFields.length);
        return;
      }
      return;
    }

    if (showDeleteConfirm) {
      if (input === "y" || input === "Y") { deleteServer(showDeleteConfirm); return; }
      return;
    }

    if (key.downArrow) { setSelectedIndex((p) => Math.min(p + 1, servers.length - 1)); return; }
    if (key.upArrow) { setSelectedIndex((p) => Math.max(p - 1, 0)); return; }
    if (input === "a" || input === "A") { setShowAddForm(true); return; }
    if ((input === "d" || input === "D") && servers[selectedIndex]) {
      setShowDeleteConfirm(servers[selectedIndex].id);
      return;
    }
  });

  const fieldLabel = (f: string) => {
    if (f === "name") return `Name [← → toggle: ${form.transport.toUpperCase()}]`;
    if (f === "url") return "URL";
    if (f === "token") return "Bearer token (optional)";
    if (f === "command") return "Command";
    if (f === "args") return "Args";
    return f;
  };

  return (
    <Box flexDirection="column" borderColor={accent} paddingX={1} paddingY={1} width="80%">
      <Text bold color={accent}>MCP Servers</Text>

      {showAddForm ? (
        <Box flexDirection="column" paddingY={1}>
          <Text bold>Add MCP Server</Text>
          {formFields.map((field, i) => {
            const isActive = activeField === i;
            const val = form[field as keyof AddForm] as string;
            const masked = field === "token" && val ? "*".repeat(val.length) : val;
            return (
              <Box key={field} flexDirection="row">
                <Text color={isActive ? accent : "gray"}>{fieldLabel(field)}: </Text>
                <Text color={isActive ? "green" : "white"}>{masked}{isActive ? "_" : ""}</Text>
              </Box>
            );
          })}
          <Text dimColor>Tab/Return advances fields · Return on last field saves · Esc cancels</Text>
          {form.transport === "http" && !form.url && activeField > 0 && (
            <Text color="red" dimColor>URL is required</Text>
          )}
        </Box>
      ) : showDeleteConfirm ? (
        <Box paddingY={1} flexDirection="column">
          <Text color="red">Delete "{servers.find((s) => s.id === showDeleteConfirm)?.name}"?</Text>
          <Text dimColor>Y to confirm · Esc to cancel</Text>
        </Box>
      ) : (
        <Box flexDirection="column" paddingY={1}>
          <Text dimColor>A: add  D: delete  ↑↓: navigate  Esc: exit</Text>
          {servers.length === 0 ? (
            <Text dimColor>No MCP servers configured</Text>
          ) : (
            servers.map((server, i) => (
              <Box key={server.id} flexDirection="row" marginRight={1}>
                <Box width={3}>
                  <Text color={i === selectedIndex ? accent : "gray"}>{i === selectedIndex ? ">" : " "}</Text>
                </Box>
                <Text>{server.name}</Text>
                <Box flexGrow={1} />
                <Text dimColor>[{server.transport}] </Text>
                <Text color={server.enabled ? "green" : "gray"}>{server.enabled ? "on" : "off"}</Text>
              </Box>
            ))
          )}
        </Box>
      )}
    </Box>
  );
}
