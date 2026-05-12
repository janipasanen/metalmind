import React from "react";
import { Box, Text } from "ink";

export default function ChatView() {
  return (
    <Box flexDirection="column" borderStyle="single" padding={1} height={20}>
      <Text dimColor>Welcome to Metalmind. Type /help for commands.</Text>
    </Box>
  );
}
