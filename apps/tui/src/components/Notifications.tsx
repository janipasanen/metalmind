import React from "react";
import { Box, Text } from "ink";

export type NotificationType = "success" | "error" | "warning" | "info";

export interface Notification {
  id: number;
  type: NotificationType;
  message: string;
}

const COLOR: Record<NotificationType, string> = {
  success: "green",
  error: "red",
  warning: "yellow",
  info: "cyan",
};

const ICON: Record<NotificationType, string> = {
  success: "✓",
  error: "✗",
  warning: "⚠",
  info: "ℹ",
};

/** Transient notification stack (legacy #8). Items auto-dismiss; App owns the
 *  queue/timers and passes the currently-visible items here. */
export default function Notifications({ items }: { items: Notification[] }) {
  if (items.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {items.map((n) => (
        <Text key={n.id} color={COLOR[n.type]}>
          {ICON[n.type]} {n.message}
        </Text>
      ))}
    </Box>
  );
}
