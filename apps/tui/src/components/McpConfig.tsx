import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { loadXdgConfig, saveXdgConfig } from "@metalmind/config";
import type { McpServerConfig } from "@metalmind/config";

interface McpServer {
  id: string;
  name: string;
  command: string;
  args?: string[];
  authType: "none" | "oauth2" | "bearer";
  enabled: boolean;
}

interface McpConfigProps {
  onDone: () => void;
  accent?: string;
}

type FormField = "name" | "command" | "args" | "authType";
const FORM_FIELDS: FormField[] = ["name", "command", "args", "authType"];
const AUTH_TYPES: Array<"none" | "oauth2" | "bearer"> = ["none", "oauth2", "bearer"];

interface AddForm {
  name: string;
  command: string;
  args: string;
  authType: "none" | "oauth2" | "bearer";
}

export default function McpConfig({ onDone, accent = "cyan" }: McpConfigProps) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [formField, setFormField] = useState<FormField>("name");
  const [form, setForm] = useState<AddForm>({ name: "", command: "", args: "", authType: "oauth2" });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);

  useEffect(() => {
    const config = loadXdgConfig();
    const mcpServers = Object.entries(config.mcpServers || {}).map(([id, cfg]) => ({
      id,
      name: cfg.name || id,
      command: cfg.command,
      args: cfg.args,
      authType: (cfg.authType ?? "none") as "none" | "oauth2" | "bearer",
      enabled: cfg.enabled,
    }));
    setServers(mcpServers);
  }, []);

  const saveServer = () => {
    if (!form.name || !form.command) return;
    const id = form.name.replace(/\s+/g, "-").toLowerCase();
    const args = form.args.split(" ").filter(Boolean);
    const newServer: McpServer = { id, name: form.name, command: form.command, args, authType: form.authType, enabled: true };
    const updatedServers = [...servers, newServer];
    const mcpServers: Record<string, McpServerConfig> = {};
    for (const s of updatedServers) {
      mcpServers[s.id] = { name: s.name, command: s.command, args: s.args, enabled: s.enabled, authType: s.authType };
    }
    saveXdgConfig({ ...loadXdgConfig(), mcpServers });
    setServers(updatedServers);
    setForm({ name: "", command: "", args: "", authType: "oauth2" });
    setFormField("name");
    setShowAddForm(false);
  };

  const deleteServer = (id: string) => {
    const updatedServers = servers.filter((s) => s.id !== id);
    const mcpServers: Record<string, McpServerConfig> = {};
    for (const s of updatedServers) {
      mcpServers[s.id] = { name: s.name, command: s.command, args: s.args, enabled: s.enabled, authType: s.authType };
    }
    saveXdgConfig({ ...loadXdgConfig(), mcpServers });
    setServers(updatedServers);
    setShowDeleteConfirm(null);
    setSelectedIndex(0);
  };

  useInput((input, key) => {
    if (key.escape) {
      if (showDeleteConfirm) { setShowDeleteConfirm(null); return; }
      if (showAddForm) { setShowAddForm(false); setForm({ name: "", command: "", args: "", authType: "oauth2" }); setFormField("name"); return; }
      onDone();
      return;
    }

    if (showAddForm) {
      if (formField === "authType") {
        if (key.leftArrow || key.upArrow) {
          setForm((f) => ({ ...f, authType: AUTH_TYPES[(AUTH_TYPES.indexOf(f.authType) - 1 + AUTH_TYPES.length) % AUTH_TYPES.length] }));
          return;
        }
        if (key.rightArrow || key.downArrow) {
          setForm((f) => ({ ...f, authType: AUTH_TYPES[(AUTH_TYPES.indexOf(f.authType) + 1) % AUTH_TYPES.length] }));
          return;
        }
      } else {
        if (key.backspace) {
          setForm((f) => ({ ...f, [formField]: (f[formField] as string).slice(0, -1) }));
          return;
        }
        if (input && !key.tab && !key.return) {
          setForm((f) => ({ ...f, [formField]: (f[formField] as string) + input }));
          return;
        }
      }

      if (key.tab || key.return) {
        const currentIdx = FORM_FIELDS.indexOf(formField);
        if (key.return && currentIdx === FORM_FIELDS.length - 1) {
          saveServer();
          return;
        }
        setFormField(FORM_FIELDS[(currentIdx + 1) % FORM_FIELDS.length]);
        return;
      }
      return;
    }

    if (showDeleteConfirm) {
      if (input === "y" || input === "Y") { deleteServer(showDeleteConfirm); return; }
      return;
    }

    if (key.downArrow) { setSelectedIndex((prev) => Math.min(prev + 1, servers.length - 1)); return; }
    if (key.upArrow) { setSelectedIndex((prev) => Math.max(prev - 1, 0)); return; }
    if (input === "a" || input === "A") { setShowAddForm(true); return; }
    if ((input === "d" || input === "D") && servers[selectedIndex]) {
      setShowDeleteConfirm(servers[selectedIndex].id);
      return;
    }
  });

  const fieldLabel = (field: FormField) => {
    if (field === "name") return "Name";
    if (field === "command") return "Command";
    if (field === "args") return "Args";
    return "Auth";
  };

  return (
    <Box flexDirection="column" borderColor={accent} paddingX={1} paddingY={1} width="70%">
      <Text bold color={accent}>MCP Servers</Text>

      {showAddForm ? (
        <Box flexDirection="column" paddingY={1}>
          <Text bold>Add MCP Server</Text>
          {FORM_FIELDS.map((field) => {
            const isActive = formField === field;
            if (field === "authType") {
              return (
                <Box key={field} flexDirection="row" marginTop={0}>
                  <Text color={isActive ? accent : "gray"}>{fieldLabel(field)}: </Text>
                  <Text color={isActive ? "green" : "white"}>{form.authType}</Text>
                  {isActive && <Text dimColor>  ← → to cycle</Text>}
                </Box>
              );
            }
            const val = form[field] as string;
            return (
              <Box key={field} flexDirection="row">
                <Text color={isActive ? accent : "gray"}>{fieldLabel(field)}: </Text>
                <Text color={isActive ? "green" : "white"}>{val}{isActive ? "_" : ""}</Text>
              </Box>
            );
          })}
          <Text dimColor>Tab/Return to next field, Return on Auth to save, Esc to cancel</Text>
          {(!form.name || !form.command) && <Text color="red" dimColor>Name and Command are required</Text>}
        </Box>
      ) : showDeleteConfirm ? (
        <Box paddingY={1} flexDirection="column">
          <Text color="red">Delete "{servers.find((s) => s.id === showDeleteConfirm)?.name}"?</Text>
          <Text dimColor>Press Y to confirm, Esc to cancel</Text>
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
                <Text dimColor>[{server.authType}] </Text>
                <Text color={server.enabled ? "green" : "gray"}>{server.enabled ? "on" : "off"}</Text>
              </Box>
            ))
          )}
        </Box>
      )}
    </Box>
  );
}
