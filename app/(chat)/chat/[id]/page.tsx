import { XylariaMcpChat } from "@/components/chat/xylaria-mcp-chat";

export default function Page({ params }: { params: { id: string } }) {
  return <XylariaMcpChat initialChatId={params.id} />;
}
