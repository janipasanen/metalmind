import React from "react";
import { Box } from "ink";
import Header from "./Header.js";
import ChatView from "./ChatView.js";

export default function App() {
  return (
    <Box flexDirection="column" padding={1}>
      <Header />
      <ChatView />
    </Box>
  );
}
