import { useWebSocket } from "../hooks/useWebSocket";
import { ChatWorkspace } from "../components/ChatWorkspace";

export default function ChatPage() {
  const { status, events, lastError, sendMessage, resolveApproval } = useWebSocket();

  return (
    <ChatWorkspace
      events={events}
      connectionStatus={status}
      lastError={lastError}
      sendMessage={sendMessage}
      resolveApproval={resolveApproval}
    />
  );
}
