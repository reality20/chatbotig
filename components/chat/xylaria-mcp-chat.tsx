"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn, generateUUID } from "@/lib/utils";

type GradioClientModule = {
  Client: {
    connect: (space: string) => Promise<{
      predict: (
        endpoint: string,
        payload: Record<string, unknown>
      ) => Promise<{ data: unknown[] }>;
    }>;
  };
  handle_file: (file: File) => unknown;
};

type ChatBot = {
  id: string;
  name: string;
  tagline: string;
  accent: string;
  helper: string;
};

type McpServer = {
  id: string;
  name: string;
  shortName: string;
  url: string;
  accent: string;
  description: string;
  preferredTools: string[];
};

type StoredMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  serverId?: string;
};

type StoredChat = {
  id: string;
  title: string;
  botId: string;
  messages: StoredMessage[];
  updatedAt: string;
};

type ToolCall = {
  server: string;
  tool: string;
  arguments?: Record<string, unknown>;
};

const STORAGE_KEY = "xylaria.local.chats.v1";
const CURRENT_CHAT_KEY = "xylaria.local.currentChat.v1";
const MAX_TOOL_LOOPS = 10;
const QWEN_SPACE = "Qwen/Qwen3-VL-235B-A22B-Instruct-Demo";

const SYSTEM_PROMPT = `You are Xylaria, made by Sk Mahammad Saad Amin.

You are an AI assistant with tool access.

If a tool is required, respond ONLY with JSON:

{
  "tool_call": {
    "server": "server_name",
    "tool": "tool_name",
    "arguments": {}
  }
}

Rules:
- One tool call at a time
- No markdown
- No explanations
- Only JSON if calling tool
- Otherwise answer normally
- Prefer the configured MCP servers for search, research, image generation, image editing, and video generation.`;

const CHATBOTS: ChatBot[] = [
  {
    id: "xylaria-orbit",
    name: "Xylaria Orbit",
    tagline: "General multimedia chat",
    accent: "from-cyan-400 via-sky-500 to-blue-600",
    helper:
      "Best for everyday questions, web work, coding, and multimodal reasoning.",
  },
  {
    id: "xylaria-forge",
    name: "Xylaria Forge",
    tagline: "Image and edit studio",
    accent: "from-fuchsia-400 via-pink-500 to-rose-600",
    helper:
      "Best for image generation, image edits, LoRAs, and visual prompt iteration.",
  },
  {
    id: "xylaria-motion",
    name: "Xylaria Motion",
    tagline: "Video and research agent",
    accent: "from-amber-300 via-orange-500 to-red-600",
    helper:
      "Best for video generation, deep research, and chained tool workflows.",
  },
];

const MCP_SERVERS: McpServer[] = [
  {
    id: "qwen-image-edit",
    name: "Qwen Image Edit 2511 LoRAs Fast",
    shortName: "Qwen Edit",
    url: "https://prithivmlmods-qwen-image-edit-2511-loras-fast.hf.space/gradio_api/mcp/",
    accent: "#9b5cff",
    description:
      "LoRA-powered image editing through the Hugging Face Gradio MCP server.",
    preferredTools: [
      "Qwen_Image_Edit_2511_LoRAs_Fast_infer",
      "Qwen_Image_Edit_2511_LoRAs_Fast_load_example_data",
      "infer",
    ],
  },
  {
    id: "wan-video",
    name: "Wan 2.2 FP8 I2V",
    shortName: "Wan Video",
    url: "https://cbensimon-wan2-2-fp8da-aoti-preview2.hf.space/gradio_api/mcp/",
    accent: "#22d3ee",
    description:
      "Image-to-video animation using Wan 2.2 14B with Lightning LoRA.",
    preferredTools: [
      "wan2_2_fp8da_aoti_preview2_generate_video",
      "wan2_2_fp8da_aoti_preview2_extract_frame",
    ],
  },
  {
    id: "nymbo-tools",
    name: "Nymbo Tools",
    shortName: "Nymbo",
    url: "https://nymbo-tools.hf.space/gradio_api/mcp/",
    accent: "#34d399",
    description:
      "Web search, fetch, research, shell, files, speech, image, and video utilities.",
    preferredTools: [
      "Tools_Agent_Terminal",
      "Tools_Web_Search",
      "Tools_Web_Fetch",
      "Tools_Deep_Research",
      "Tools_Generate_Image",
      "Tools_Generate_Video",
      "Tools_Generate_Speech",
    ],
  },
  {
    id: "z-image-turbo",
    name: "Z-Image Turbo",
    shortName: "Z Image",
    url: "https://mrfakename-z-image-turbo.hf.space/gradio_api/mcp/",
    accent: "#fb7185",
    description: "Fast text-to-image generation through Z-Image Turbo.",
    preferredTools: [
      "Z_Image_Turbo_generate_image",
      "Z_Image_Turbo_generate_image_1",
      "Z_Image_Turbo_toggle_seed",
    ],
  },
];

function loadGradioClient() {
  const importFromCdn = new Function(
    'return import("https://cdn.jsdelivr.net/npm/@gradio/client/+esm")'
  ) as () => Promise<GradioClientModule>;
  return importFromCdn();
}

function createEmptyChat(botId = CHATBOTS[0].id): StoredChat {
  return {
    id: generateUUID(),
    title: "New Xylaria chat",
    botId,
    messages: [],
    updatedAt: new Date().toISOString(),
  };
}

function getChatTitle(text: string) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 42) : "New Xylaria chat";
}

function extractTextFromQwen(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const last = value.at(-1);
    if (Array.isArray(last)) {
      return String(last[1] ?? "");
    }
  }
  return String(value ?? "");
}

function parseToolCall(text: string): ToolCall | null {
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed?.tool_call?.server && parsed?.tool_call?.tool) {
      return parsed.tool_call as ToolCall;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeServerId(server: string) {
  const lowered = server.toLowerCase();
  return (
    MCP_SERVERS.find(
      (candidate) =>
        candidate.id === lowered ||
        candidate.shortName.toLowerCase() === lowered ||
        candidate.name.toLowerCase() === lowered ||
        lowered.includes(candidate.id) ||
        lowered.includes(candidate.shortName.toLowerCase().replace(/\s+/g, "-"))
    ) ??
    MCP_SERVERS.find((candidate) =>
      lowered.includes(candidate.id.split("-")[0])
    )
  );
}

async function readMcpResponse(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  if (contentType.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .at(-1);
    return data ? JSON.parse(data) : { raw: text };
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function callMcpTool(toolCall: ToolCall) {
  const server = normalizeServerId(toolCall.server) ?? MCP_SERVERS[2];
  const payload = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: {
      name: toolCall.tool,
      arguments: toolCall.arguments ?? {},
    },
  };

  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`${server.name} returned ${response.status}`);
  }

  return {
    serverId: server.id,
    server: server.name,
    tool: toolCall.tool,
    result: await readMcpResponse(response),
  };
}

function ServerAnimation({
  server,
  active,
}: {
  server: McpServer;
  active: boolean;
}) {
  return (
    <svg
      aria-label={`${server.name} animation`}
      className={cn(
        "h-16 w-16 transition duration-500",
        active ? "scale-110 opacity-100" : "opacity-55"
      )}
      viewBox="0 0 120 120"
    >
      <defs>
        <radialGradient cx="50%" cy="50%" id={`glow-${server.id}`} r="50%">
          <stop offset="0%" stopColor={server.accent} stopOpacity="0.95" />
          <stop offset="55%" stopColor={server.accent} stopOpacity="0.22" />
          <stop offset="100%" stopColor={server.accent} stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="60" cy="60" fill={`url(#glow-${server.id})`} r="44">
        {active && (
          <animate
            attributeName="r"
            dur="1.8s"
            repeatCount="indefinite"
            values="34;52;34"
          />
        )}
      </circle>
      <g
        fill="none"
        stroke={server.accent}
        strokeLinecap="round"
        strokeWidth="3"
      >
        <circle cx="60" cy="60" r="24" strokeOpacity="0.9" />
        <path d="M60 18a42 42 0 0 1 42 42" strokeOpacity="0.7">
          {active && (
            <animateTransform
              attributeName="transform"
              dur="2.8s"
              from="0 60 60"
              repeatCount="indefinite"
              to="360 60 60"
              type="rotate"
            />
          )}
        </path>
        <path d="M18 60a42 42 0 0 1 42-42" strokeOpacity="0.45">
          {active && (
            <animateTransform
              attributeName="transform"
              dur="3.6s"
              from="360 60 60"
              repeatCount="indefinite"
              to="0 60 60"
              type="rotate"
            />
          )}
        </path>
        <path d="M43 60h34M60 43v34" strokeOpacity="0.82" />
      </g>
      <circle cx="60" cy="60" fill={server.accent} r="5">
        {active && (
          <animate
            attributeName="opacity"
            dur="0.9s"
            repeatCount="indefinite"
            values="1;0.35;1"
          />
        )}
      </circle>
    </svg>
  );
}

export function XylariaMcpChat() {
  const [chats, setChats] = useState<StoredChat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string>("");
  const [selectedBotId, setSelectedBotId] = useState(CHATBOTS[0].id);
  const [prompt, setPrompt] = useState("Hello!!");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [status, setStatus] = useState("Ready");
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const gradioHistoryRef = useRef<unknown[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const currentId = window.localStorage.getItem(CURRENT_CHAT_KEY);
    const parsed = stored ? (JSON.parse(stored) as StoredChat[]) : [];
    const seeded = parsed.length ? parsed : [createEmptyChat()];
    setChats(seeded);
    setActiveChatId(
      currentId && seeded.some((chat) => chat.id === currentId)
        ? currentId
        : seeded[0].id
    );
    setSelectedBotId(seeded[0].botId);
  }, []);

  useEffect(() => {
    if (chats.length) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
    }
  }, [chats]);

  useEffect(() => {
    if (activeChatId) {
      window.localStorage.setItem(CURRENT_CHAT_KEY, activeChatId);
      const active = chats.find((chat) => chat.id === activeChatId);
      if (active) {
        setSelectedBotId(active.botId);
      }
    }
  }, [activeChatId, chats]);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const activeChat = useMemo(
    () => chats.find((chat) => chat.id === activeChatId) ?? chats[0],
    [activeChatId, chats]
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  });

  const selectedBot =
    CHATBOTS.find((bot) => bot.id === selectedBotId) ?? CHATBOTS[0];

  const syncGradioHistory = (history: unknown[]) => {
    gradioHistoryRef.current = history;
  };

  const updateActiveChat = (updater: (chat: StoredChat) => StoredChat) => {
    setChats((current) =>
      current.map((chat) => (chat.id === activeChatId ? updater(chat) : chat))
    );
  };

  const appendMessage = (message: Omit<StoredMessage, "id" | "createdAt">) => {
    const fullMessage: StoredMessage = {
      id: generateUUID(),
      createdAt: new Date().toISOString(),
      ...message,
    };
    updateActiveChat((chat) => ({
      ...chat,
      title:
        chat.messages.length === 0 && message.role === "user"
          ? getChatTitle(message.content)
          : chat.title,
      botId: selectedBotId,
      messages: [...chat.messages, fullMessage],
      updatedAt: new Date().toISOString(),
    }));
  };

  const startNewChat = (botId = selectedBotId) => {
    const chat = createEmptyChat(botId);
    setChats((current) => [chat, ...current]);
    setActiveChatId(chat.id);
    setSelectedBotId(botId);
    syncGradioHistory([]);
    setPrompt("Hello!!");
  };

  const deleteChat = (chatId: string) => {
    setChats((current) => {
      const next = current.filter((chat) => chat.id !== chatId);
      if (activeChatId === chatId) {
        const replacement = next[0] ?? createEmptyChat(selectedBotId);
        setActiveChatId(replacement.id);
        return next.length ? next : [replacement];
      }
      return next;
    });
  };

  const qwenStep = async (
    client: Awaited<ReturnType<GradioClientModule["Client"]["connect"]>>,
    text: string
  ) => {
    const add = await client.predict("/add_text", {
      history: gradioHistoryRef.current,
      text,
    });
    const nextHistory = (add.data[0] as unknown[]) ?? [];
    syncGradioHistory(nextHistory);

    const pred = await client.predict("/predict", {
      _chatbot: nextHistory,
    });
    const predictedHistory = (pred.data[0] as unknown[]) ?? [];
    syncGradioHistory(predictedHistory);
    return extractTextFromQwen(predictedHistory);
  };

  const uploadMedia = async (
    client: Awaited<ReturnType<GradioClientModule["Client"]["connect"]>>,
    handleFile: GradioClientModule["handle_file"]
  ) => {
    if (!file) {
      return;
    }
    setStatus("Uploading media to Qwen...");
    const upload = await client.predict("/add_file", {
      history: gradioHistoryRef.current,
      file: handleFile(file),
    });
    syncGradioHistory((upload.data[0] as unknown[]) ?? []);
  };

  const runAgent = async () => {
    if (!prompt.trim() || isRunning) {
      return;
    }

    const userPrompt = prompt.trim();
    appendMessage({ role: "user", content: userPrompt });
    setPrompt("");
    setIsRunning(true);
    setActiveServerId(null);

    try {
      setStatus("Connecting to Qwen...");
      const { Client, handle_file: handleFile } = await loadGradioClient();
      const client = await Client.connect(QWEN_SPACE);

      await uploadMedia(client, handleFile);

      setStatus(`${selectedBot.name} is thinking...`);
      let response = await qwenStep(
        client,
        `${SYSTEM_PROMPT}

Active chatbot: ${selectedBot.name} — ${selectedBot.helper}

Available MCP servers:
${MCP_SERVERS.map(
  (server) =>
    `- ${server.id} (${server.name}): ${server.description}. Tools: ${server.preferredTools.join(", ")}`
).join("\n")}

User:
${userPrompt}`
      );

      for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
        const toolCall = parseToolCall(response);
        if (!toolCall) {
          appendMessage({
            role: "assistant",
            content: response || "I could not produce a response.",
          });
          setStatus("Ready");
          return;
        }

        const server = normalizeServerId(toolCall.server) ?? MCP_SERVERS[2];
        setActiveServerId(server.id);
        setStatus(`Calling ${server.name} → ${toolCall.tool}`);
        appendMessage({
          role: "tool",
          serverId: server.id,
          content: `Calling ${server.name}.${toolCall.tool}\n${JSON.stringify(toolCall.arguments ?? {}, null, 2)}`,
        });

        const toolResult = await callMcpTool(toolCall);
        appendMessage({
          role: "tool",
          serverId: toolResult.serverId,
          content: `Tool result from ${toolResult.server}.${toolResult.tool}\n${JSON.stringify(toolResult.result, null, 2)}`,
        });

        setStatus(`${selectedBot.name} is reading the tool result...`);
        response = await qwenStep(
          client,
          `Tool result:

${JSON.stringify(toolResult, null, 2)}

Continue helping user.`
        );
      }

      appendMessage({ role: "assistant", content: "Max tool loops reached." });
      setStatus("Ready");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : JSON.stringify(error);
      appendMessage({ role: "assistant", content: `Error: ${message}` });
      setStatus("Error");
    } finally {
      setIsRunning(false);
      setActiveServerId(null);
    }
  };

  return (
    <main className="min-h-dvh overflow-hidden bg-[#050713] text-white">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.22),transparent_34%),radial-gradient(circle_at_80%_20%,rgba(217,70,239,0.2),transparent_32%),radial-gradient(circle_at_50%_90%,rgba(251,113,133,0.16),transparent_35%)]" />
      <div className="relative mx-auto grid min-h-dvh max-w-7xl grid-cols-1 gap-4 p-4 lg:grid-cols-[320px_1fr]">
        <aside className="flex min-h-[300px] flex-col rounded-3xl border border-white/10 bg-white/[0.06] p-4 shadow-2xl shadow-black/30 backdrop-blur-xl">
          <div className="mb-5">
            <p className="text-xs font-semibold uppercase tracking-[0.35em] text-cyan-200/80">
              Local device chat
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-tight">Xylaria</h1>
            <p className="mt-1 text-sm text-white/60">
              Made by Sk Mahammad Saad Amin. No login. Chats stay in this
              browser.
            </p>
          </div>

          <Button
            className="mb-4 rounded-2xl bg-cyan-400 text-black hover:bg-cyan-300"
            onClick={() => startNewChat()}
          >
            New chat
          </Button>

          <div className="mb-4 grid gap-2">
            {CHATBOTS.map((bot) => (
              <button
                className={cn(
                  "rounded-2xl border p-3 text-left transition hover:-translate-y-0.5",
                  selectedBotId === bot.id
                    ? "border-white/35 bg-white/15"
                    : "border-white/10 bg-white/[0.04]"
                )}
                key={bot.id}
                onClick={() => {
                  setSelectedBotId(bot.id);
                  updateActiveChat((chat) => ({ ...chat, botId: bot.id }));
                }}
                type="button"
              >
                <div
                  className={cn(
                    "mb-2 h-1.5 rounded-full bg-gradient-to-r",
                    bot.accent
                  )}
                />
                <div className="font-semibold">{bot.name}</div>
                <div className="text-xs text-white/55">{bot.tagline}</div>
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.22em] text-white/45">
              History
            </p>
            <div className="space-y-2">
              {chats.map((chat) => (
                <div
                  className={cn(
                    "group flex items-center gap-2 rounded-xl border px-3 py-2 text-sm",
                    chat.id === activeChatId
                      ? "border-cyan-300/40 bg-cyan-300/10"
                      : "border-white/10 bg-white/[0.03]"
                  )}
                  key={chat.id}
                >
                  <button
                    className="min-w-0 flex-1 truncate text-left"
                    onClick={() => setActiveChatId(chat.id)}
                    type="button"
                  >
                    {chat.title}
                  </button>
                  <button
                    className="text-white/35 opacity-0 transition hover:text-rose-300 group-hover:opacity-100"
                    onClick={() => deleteChat(chat.id)}
                    type="button"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        </aside>

        <section className="flex min-h-[calc(100dvh-2rem)] flex-col rounded-3xl border border-white/10 bg-black/30 shadow-2xl shadow-black/30 backdrop-blur-xl">
          <header className="border-white/10 border-b p-4">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <p className="text-sm text-white/55">{selectedBot.tagline}</p>
                <h2 className="text-2xl font-bold">{selectedBot.name}</h2>
                <p className="text-sm text-white/60">{selectedBot.helper}</p>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {MCP_SERVERS.map((server) => (
                  <div
                    className="rounded-2xl border border-white/10 bg-white/[0.04] p-2 text-center"
                    key={server.id}
                  >
                    <ServerAnimation
                      active={activeServerId === server.id}
                      server={server}
                    />
                    <p className="mt-1 text-xs font-semibold">
                      {server.shortName}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </header>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {(activeChat?.messages.length ?? 0) === 0 ? (
              <div className="grid h-full place-items-center py-12 text-center">
                <div className="max-w-xl">
                  <div
                    className={cn(
                      "mx-auto mb-6 h-2 w-40 rounded-full bg-gradient-to-r",
                      selectedBot.accent
                    )}
                  />
                  <h3 className="text-4xl font-black">
                    Qwen + MCP Multimedia Chat
                  </h3>
                  <p className="mt-3 text-white/60">
                    Upload an image or video, ask Xylaria anything, and it can
                    call the configured Hugging Face MCP servers with animated
                    status indicators.
                  </p>
                </div>
              </div>
            ) : (
              activeChat?.messages.map((message) => (
                <article
                  className={cn(
                    "max-w-[85%] rounded-3xl border p-4 text-sm leading-6 shadow-lg",
                    message.role === "user" &&
                      "ml-auto border-cyan-300/20 bg-cyan-300/10",
                    message.role === "assistant" &&
                      "border-white/10 bg-white/[0.07]",
                    message.role === "tool" &&
                      "border-amber-300/20 bg-amber-300/10 font-mono text-xs"
                  )}
                  key={message.id}
                >
                  <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-white/45">
                    {message.role === "user"
                      ? "You"
                      : message.role === "assistant"
                        ? selectedBot.name
                        : "MCP Tool"}
                  </div>
                  <pre className="whitespace-pre-wrap font-inherit">
                    {message.content}
                  </pre>
                </article>
              ))
            )}
            <div ref={endRef} />
          </div>

          <footer className="border-white/10 border-t p-4">
            <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-end">
              <label className="flex-1">
                <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.22em] text-white/45">
                  Prompt
                </span>
                <textarea
                  className="h-28 w-full resize-none rounded-2xl border border-white/10 bg-white/[0.06] p-4 text-base outline-none ring-cyan-300/40 transition placeholder:text-white/30 focus:ring-2"
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      (event.metaKey || event.ctrlKey) &&
                      event.key === "Enter"
                    ) {
                      runAgent();
                    }
                  }}
                  placeholder="Message Xylaria..."
                  value={prompt}
                />
              </label>
              <div className="w-full lg:w-72">
                <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.22em] text-white/45">
                  Media
                </span>
                <input
                  accept="image/*,video/*"
                  className="block w-full rounded-2xl border border-white/10 bg-white/[0.06] p-3 text-sm file:mr-3 file:rounded-xl file:border-0 file:bg-white/15 file:px-3 file:py-2 file:text-white"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  type="file"
                />
                {previewUrl && file?.type.startsWith("image/") ? (
                  // biome-ignore lint/performance/noImgElement: Blob previews from user-selected local files should not go through next/image.
                  <img
                    alt="Selected media preview"
                    className="mt-3 max-h-36 rounded-2xl border border-white/10 object-contain"
                    src={previewUrl}
                  />
                ) : null}
                {previewUrl && file?.type.startsWith("video/") ? (
                  // biome-ignore lint/a11y/useMediaCaption: User-selected local video previews may not have caption tracks.
                  <video
                    className="mt-3 max-h-36 rounded-2xl border border-white/10"
                    controls
                    src={previewUrl}
                  />
                ) : null}
              </div>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-white/55">
                Status: <span className="text-white">{status}</span>
              </p>
              <Button
                className="rounded-2xl bg-white px-8 text-black hover:bg-cyan-100"
                disabled={isRunning}
                onClick={runAgent}
              >
                {isRunning ? "Working..." : "Send"}
              </Button>
            </div>
          </footer>
        </section>
      </div>
    </main>
  );
}
