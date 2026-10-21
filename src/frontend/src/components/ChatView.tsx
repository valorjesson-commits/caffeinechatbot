import {
  type ChatMessage,
  type CompletionResult,
  GatewayError,
  type InferenceCredentials,
  MAX_IMAGE_BYTES,
  type SearchResponse,
  completeDirect,
  describeImage,
  devCredentials,
  searchWeb,
} from "@/lib/inference";
import { useActor, useInternetIdentity } from "@caffeineai/core-infrastructure";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  Globe,
  Image as ImageIcon,
  Loader2,
  LogOut,
  MessageSquare,
  PanelLeft,
  Plus,
  Send,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  type ConversationSummary,
  type MessagePage,
  type StoredMessage,
  Variant_user_assistant,
  createActor,
} from "../backend";

// What gets sent to the model per turn: system prompt + running summary (if
// any) + the most recent messages that fit this character budget (~24k
// tokens). The full transcript stays in the canister and on screen.
const PROMPT_CHAR_BUDGET = 96_000;
// Compaction: once this many stored messages are not covered by the summary,
// extend the summary (in chunks) until only the tail is uncovered.
const COMPACT_TRIGGER = 80;
const COMPACT_TAIL = 40;
const COMPACT_CHUNK = 60;
const SUMMARIZE_PROMPT =
  "You maintain a running summary of a conversation. Merge the previous summary (if any) with the new messages into ONE updated summary under 4000 characters. Keep concrete facts, names, numbers, decisions, and open questions. Output only the summary text.";

// Decode rate over the generation span (first token to completion); the
// pre-token wait is time-to-first-token's story, not throughput's.
function tokensPerSecond(result: CompletionResult): number | undefined {
  if (!result.outputTokens) return undefined;
  const generationMs =
    result.firstTokenMs !== undefined &&
    result.latencyMs > result.firstTokenMs + 50
      ? result.latencyMs - result.firstTokenMs
      : result.latencyMs;
  if (generationMs <= 0) return undefined;
  return Math.round((result.outputTokens / generationMs) * 1000);
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// The readable core of a canister reject: the trap message without the
// replica's request/error-code framing.
function trapMessage(error: unknown): string {
  const raw = String((error as Error)?.message ?? error);
  const match = raw.match(/trap.*?'(.*)'/s);
  return match ? match[1] : raw.slice(0, 300);
}

// The one tool search-enabled chats offer; the model decides when to use it.
const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web for current information. Use it for recent events, " +
      "facts that may have changed, or anything beyond your training data.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language search query.",
        },
      },
      required: ["query"],
    },
  },
};
// The model gets at most this many search rounds per user message.
const MAX_TOOL_ITERATIONS = 3;

const IMAGE_MARKER = /^\[Attached image "(.+)"\]$/;

/** Splits a user message into the text to show and the image-chip names.
 * Blocks opening with an image marker carry the (hidden) description; the
 * marker's filename becomes a chip. Everything else is the typed text. */
function parseUserContent(content: string): { text: string; images: string[] } {
  const images: string[] = [];
  const text: string[] = [];
  for (const block of content.split("\n\n")) {
    const marker = block.split("\n", 1)[0].match(IMAGE_MARKER);
    if (marker) {
      images.push(marker[1]);
    } else if (block.trim().length > 0) {
      text.push(block);
    }
  }
  return { text: text.join("\n\n"), images };
}

const SYSTEM_PROMPT =
  "You are CaffeineChatBot, a concise and friendly assistant. Answer directly; use short paragraphs. Format answers in Markdown.";

interface DisplayMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** Streamed reasoning trace; shown above the reply, never sent back to the
   * model or stored in history. */
  reasoning?: string;
  meta?: { latencyMs: number; firstTokenMs?: number; tokensPerSecond?: number };
  /** Search results the reply drew on; rendered as a source-link row. */
  sources?: { title: string; url: string }[];
  error?: boolean;
  /** Still receiving streamed deltas. */
  streaming?: boolean;
}

// The history surface ChatView needs from the backend; in dev without a
// replica (VITE_DEV_INFERENCE_KEY) an in-memory stand-in implements it so the
// sidebar and history flows stay exercisable.
interface HistoryBackend {
  listConversations(): Promise<ConversationSummary[]>;
  getConversationPage(id: bigint, start: bigint): Promise<MessagePage>;
  recordExchange(
    conversationId: bigint | null,
    userContent: string,
    assistantContent: string,
  ): Promise<bigint>;
  setConversationSummary(
    id: bigint,
    coversCount: bigint,
    content: string,
  ): Promise<void>;
  deleteConversation(id: bigint): Promise<void>;
}

interface ActiveSummary {
  content: string;
  coversCount: number;
}

// A dropped image, held in memory until send. Describing happens AT SEND so
// the user's typed message steers the description (the gateway's `question`),
// then the description replaces the image everywhere — prompt, transcript,
// canister history — so the chat stays text-only and nothing resends bytes.
interface Attachment {
  id: number;
  name: string;
  status: "ready" | "describing" | "error";
  /** Base64 data URL, browser memory only; dropped once described. */
  dataUrl?: string;
  errorMessage?: string;
}

function makeDevHistory(): HistoryBackend {
  const chats = new Map<
    bigint,
    {
      title: string;
      updatedAtNs: bigint;
      messages: StoredMessage[];
      summary?: { content: string; coversCount: bigint; createdAtNs: bigint };
    }
  >();
  let nextId = 0n;
  return {
    async listConversations() {
      return [...chats.entries()]
        .map(([id, c]) => ({
          id,
          title: c.title,
          updatedAtNs: c.updatedAtNs,
          messageCount: BigInt(c.messages.length),
        }))
        .sort((a, b) => Number(b.updatedAtNs - a.updatedAtNs));
    },
    async getConversationPage(id, start) {
      const chat = chats.get(id);
      const all = chat?.messages ?? [];
      const from = Number(start);
      return {
        messages: all.slice(from, from + 25),
        total: BigInt(all.length),
        summary: chat?.summary,
      };
    },
    async recordExchange(conversationId, userContent, assistantContent) {
      const now = BigInt(Date.now()) * 1_000_000n;
      let id = conversationId;
      if (id === null || !chats.has(id)) {
        id = nextId++;
        chats.set(id, {
          title:
            userContent
              .split("\n\n")
              .find((block) => !block.startsWith("[Attached image "))
              ?.split("\n")[0]
              ?.slice(0, 48) ?? "Image chat",
          updatedAtNs: now,
          messages: [],
        });
      }
      const chat = chats.get(id);
      if (chat) {
        chat.messages.push(
          {
            role: Variant_user_assistant.user,
            content: userContent,
            createdAtNs: now,
          },
          {
            role: Variant_user_assistant.assistant,
            content: assistantContent,
            createdAtNs: now,
          },
        );
        chat.updatedAtNs = now;
      }
      return id;
    },
    async setConversationSummary(id, coversCount, content) {
      const chat = chats.get(id);
      if (!chat) throw new Error("Unknown conversation");
      if (chat.summary && coversCount <= chat.summary.coversCount) {
        throw new Error("Summary coverage must grow");
      }
      chat.summary = {
        content,
        coversCount,
        createdAtNs: BigInt(Date.now()) * 1_000_000n,
      };
    },
    async deleteConversation(id) {
      chats.delete(id);
    },
  };
}

const devHistory = devCredentials() ? makeDevHistory() : null;
if (devHistory) {
  // Dev-only: lets browser-driven tests seed history without streaming.
  (window as unknown as { __devHistory: HistoryBackend }).__devHistory =
    devHistory;
}

export default function ChatView() {
  const { clear } = useInternetIdentity();
  const { actor, isFetching: actorFetching } = useActor(createActor);
  const queryClient = useQueryClient();
  const history: HistoryBackend | null = devHistory ?? actor ?? null;

  const [messages, setMessages] = useState<DisplayMessage[]>(() => {
    if (!import.meta.env.DEV) return [];
    if (!devCredentials() || !location.search.includes("demo")) return [];
    return [
      {
        id: -6,
        role: "user",
        content:
          '[Attached image "team-offsite-invoice.png"]\nAn invoice from Hotel Bellevue for a 2-night team offsite, total EUR 4,320.\n\nWhat did we pay per person for the offsite? 12 people attended.',
      },
      {
        id: -5,
        role: "assistant",
        content:
          "The invoice totals **€4,320** for the two nights. Split across 12 people, that comes to **€360 per person** for the whole offsite, or €180 per person per night.",
        meta: { latencyMs: 1840, firstTokenMs: 230, tokensPerSecond: 96 },
      },
      {
        id: -4,
        role: "user",
        content:
          "What's the weather in Zurich this weekend? We're planning the next one outdoors.",
      },
      {
        id: -3,
        role: "assistant",
        content:
          "This weekend in Zurich looks friendly for an outdoor plan: **sunny Saturday around 24°C**, and Sunday partly cloudy at 22°C with a low chance of rain in the evening. Saturday is your safer bet.",
        sources: [
          {
            title: "Zurich weekend forecast — MeteoSwiss",
            url: "https://www.meteoswiss.admin.ch",
          },
          { title: "Zurich 7-day weather", url: "https://www.weather.com" },
        ],
        meta: { latencyMs: 3120, firstTokenMs: 410, tokensPerSecond: 88 },
      },
    ];
  });
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [searchingQuery, setSearchingQuery] = useState<string | null>(null);
  const [readingImages, setReadingImages] = useState(false);
  const [activeChatId, setActiveChatId] = useState<bigint | null>(null);
  const [activeSummary, setActiveSummary] = useState<ActiveSummary | null>(
    null,
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  // Distinguishes entering a child element from leaving the drop zone.
  const dragDepth = useRef(0);
  const nextAttachmentId = useRef(0);
  const nextId = useRef(0);
  // Latest values for async flows (compaction, persistence) that outlive a
  // render.
  const messagesRef = useRef<DisplayMessage[]>([]);
  messagesRef.current = messages;
  const summaryRef = useRef<ActiveSummary | null>(null);
  summaryRef.current = activeSummary;
  const storedCountRef = useRef(0);
  const compactingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The active chat can change while an exchange is in flight; the exchange
  // records into the chat it started in.
  const activeChatRef = useRef<bigint | null>(null);
  activeChatRef.current = activeChatId;
  // Follow the newest text while the reader is at (or near) the bottom;
  // release when they scroll up to read, re-engage when they send or return.
  const stickToBottom = useRef(true);

  // The inference credentials live in TanStack Query's in-memory cache only.
  const credentialsQuery = useQuery<InferenceCredentials>({
    queryKey: ["inferenceCredentials"],
    queryFn: async () => {
      const dev = devCredentials();
      if (dev) return dev;
      if (!actor) throw new Error("Actor not ready");
      return actor.getInferenceCredentials();
    },
    enabled: !!devCredentials() || (!!actor && !actorFetching),
    staleTime: Number.POSITIVE_INFINITY,
    // A grant includes an HTTP outcall, so transient failures happen; retry
    // those, but not rate limiting (retrying is what rate limiting refuses).
    retry: (failureCount, error) =>
      failureCount < 2 && !String(error).includes("Rate limited"),
    retryDelay: 2_000,
  });

  const conversationsQuery = useQuery<ConversationSummary[]>({
    queryKey: ["conversations"],
    queryFn: () => {
      if (!history) throw new Error("Backend not ready");
      return history.listConversations();
    },
    enabled: !!history,
  });

  // The backend hands out short-lived ephemeral keys; refresh shortly before
  // expiry so no message ever has to eat the 401-and-retry path.
  const expiresAt = credentialsQuery.data?.expiresAt;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arm only when a new key arrives; refetch is stable
  useEffect(() => {
    if (!expiresAt) return;
    const refreshInMs = new Date(expiresAt).getTime() - Date.now() - 120_000;
    if (!Number.isFinite(refreshInMs)) return;
    const timer = setTimeout(
      () => void credentialsQuery.refetch(),
      Math.max(refreshInMs, 5_000),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);

  // Instant (not smooth) scrolling: smooth animations cannot keep up with
  // streamed deltas and stall partway, which reads as broken scrolling.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every message/delta and pending toggle
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  // Attach = validate and read into memory; the describe call waits for send
  // so it can carry the typed message as its question.
  function attachImages(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      nextAttachmentId.current += 1;
      const id = nextAttachmentId.current;
      const name = file.name || "image";
      if (file.size > MAX_IMAGE_BYTES) {
        setAttachments((prior) => [
          ...prior,
          { id, name, status: "error", errorMessage: "over the 8MB limit" },
        ]);
        continue;
      }
      setAttachments((prior) => [...prior, { id, name, status: "describing" }]);
      void (async () => {
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(new Error("could not read the file"));
            reader.readAsDataURL(file);
          });
          setAttachments((prior) =>
            prior.map((a) =>
              a.id === id ? { ...a, status: "ready", dataUrl } : a,
            ),
          );
        } catch (error) {
          setAttachments((prior) =>
            prior.map((a) =>
              a.id === id
                ? {
                    ...a,
                    status: "error",
                    errorMessage:
                      error instanceof Error ? error.message : "failed",
                  }
                : a,
            ),
          );
        }
      })();
    }
  }

  function removeAttachment(id: number) {
    setAttachments((prior) => prior.filter((a) => a.id !== id));
  }

  function pushMessage(message: Omit<DisplayMessage, "id">): number {
    nextId.current += 1;
    const id = nextId.current;
    setMessages((prior) => [...prior, { ...message, id }]);
    return id;
  }

  function appendToMessage(id: number, delta: string) {
    setMessages((prior) =>
      prior.map((m) =>
        m.id === id ? { ...m, content: m.content + delta } : m,
      ),
    );
  }

  function appendReasoning(id: number, delta: string) {
    setMessages((prior) =>
      prior.map((m) =>
        m.id === id ? { ...m, reasoning: (m.reasoning ?? "") + delta } : m,
      ),
    );
  }

  function finalizeMessage(id: number, patch: Partial<DisplayMessage>) {
    setMessages((prior) =>
      prior.map((m) =>
        m.id === id ? { ...m, ...patch, streaming: false } : m,
      ),
    );
  }

  function setMessageContent(id: number, content: string) {
    setMessages((prior) =>
      prior.map((m) => (m.id === id ? { ...m, content } : m)),
    );
  }

  function removeMessage(id: number) {
    setMessages((prior) => prior.filter((m) => m.id !== id));
  }

  function startNewChat() {
    setActiveChatId(null);
    setMessages([]);
    setActiveSummary(null);
    storedCountRef.current = 0;
    setSidebarOpen(false);
    stickToBottom.current = true;
  }

  // Conversations load in 25-message pages (each canister reply is size
  // bounded): first page immediately, the rest fetched in parallel.
  async function openChat(id: bigint) {
    if (!history) return;
    setActiveChatId(id);
    setSidebarOpen(false);
    stickToBottom.current = true;
    const first = await history.getConversationPage(id, 0n);
    const total = Number(first.total);
    let stored: StoredMessage[] = first.messages;
    if (total > first.messages.length) {
      const starts: bigint[] = [];
      for (let s = first.messages.length; s < total; s += 25) {
        starts.push(BigInt(s));
      }
      const rest = await Promise.all(
        starts.map((start) => history.getConversationPage(id, start)),
      );
      stored = [...first.messages, ...rest.flatMap((page) => page.messages)];
    }
    nextId.current = 0;
    setMessages(
      stored.map((m, index) => ({
        id: index + 1,
        role: m.role === Variant_user_assistant.user ? "user" : "assistant",
        content: m.content,
      })),
    );
    nextId.current = stored.length + 1;
    storedCountRef.current = total;
    const summary = first.summary
      ? {
          content: first.summary.content,
          coversCount: Number(first.summary.coversCount),
        }
      : null;
    setActiveSummary(summary);
    summaryRef.current = summary;
    void runCompaction(id);
  }

  async function deleteChat(id: bigint) {
    if (!history) return;
    await history.deleteConversation(id);
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    if (activeChatId === id) startNewChat();
  }

  // Persist a completed exchange without blocking the chat: fire-and-forget,
  // and quietly leave the transcript unsaved if the canister call fails.
  function persistExchange(userContent: string, assistantContent: string) {
    if (!history) return;
    const startedIn = activeChatRef.current;
    void history
      .recordExchange(startedIn, userContent, assistantContent)
      .then((conversationId) => {
        if (startedIn === null && activeChatRef.current === null) {
          setActiveChatId(conversationId);
        }
        storedCountRef.current += 2;
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
        void runCompaction(conversationId);
      })
      .catch((error) => {
        console.warn("history save failed:", trapMessage(error));
      });
  }

  // Extends the running summary until only the recent tail is uncovered.
  // Chunked so one pass never builds an oversized summarization prompt, and
  // fully off the hot path — a failure just means compaction retries after a
  // later exchange. The full transcript is never touched.
  async function runCompaction(conversationId: bigint) {
    if (!history || compactingRef.current) return;
    if (activeChatRef.current !== conversationId) return;
    const credentials = credentialsQuery.data;
    if (!credentials) return;
    compactingRef.current = true;
    try {
      let covers = summaryRef.current?.coversCount ?? 0;
      let passes = 0;
      while (
        storedCountRef.current - covers > COMPACT_TRIGGER &&
        passes < 5 &&
        activeChatRef.current === conversationId
      ) {
        const target = Math.min(
          covers + COMPACT_CHUNK,
          storedCountRef.current - COMPACT_TAIL,
        );
        if (target <= covers) break;
        // Display order matches stored order (unsaved failures are rare and
        // only shift the window, never corrupt stored data).
        const chunk = messagesRef.current
          .filter((m) => !m.error && m.content.length > 0)
          .slice(covers, target)
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n\n")
          .slice(0, PROMPT_CHAR_BUDGET);
        const prior = summaryRef.current?.content;
        const result = await completeDirect(
          credentials,
          [
            { role: "system", content: SUMMARIZE_PROMPT },
            {
              role: "user",
              content: `${prior ? `Previous summary:\n${prior}\n\n` : ""}New messages:\n${chunk}`,
            },
          ],
          {},
        );
        const content = result.content.trim().slice(0, 5_500);
        if (content.length === 0) break;
        await history.setConversationSummary(
          conversationId,
          BigInt(target),
          content,
        );
        const summary = { content, coversCount: target };
        summaryRef.current = summary;
        if (activeChatRef.current === conversationId) {
          setActiveSummary(summary);
        }
        covers = target;
        passes += 1;
      }
    } catch (error) {
      console.warn("compaction skipped:", trapMessage(error));
    } finally {
      compactingRef.current = false;
    }
  }

  async function send() {
    const typed = draft.trim();
    const images = attachments.filter((a) => a.status === "ready" && a.dataUrl);
    if ((!typed && images.length === 0) || pending) return;
    if (attachments.some((a) => a.status === "describing")) return;
    setPending(true);

    // The message lands on screen the moment Enter is hit: typed text plus
    // one image marker per attachment. The bubble renders markers as chips
    // and never shows description text.
    const markers = images
      .map((a) => `[Attached image "${a.name}"]`)
      .join("\n\n");
    const heldAttachments = attachments;
    let prompt = [markers, typed].filter(Boolean).join("\n\n");
    setDraft("");
    setAttachments([]);
    stickToBottom.current = true;
    const userMessageId = pushMessage({ role: "user", content: prompt });

    // Describe behind the visible message, with the typed text steering the
    // description (the gateway caps the question at 2000 chars). The
    // substitution then replaces each marker with marker-plus-description in
    // the message content — the prompt the model sees and the transcript the
    // canister stores — while the bubble keeps showing chips only. No image
    // bytes ever resend.
    if (images.length > 0) {
      const credentials = credentialsQuery.data;
      if (!credentials) {
        removeMessage(userMessageId);
        setDraft(typed);
        setAttachments(heldAttachments);
        setPending(false);
        return;
      }
      setReadingImages(true);
      const question = typed ? typed.slice(0, 2_000) : undefined;
      let descriptions: string[];
      try {
        descriptions = await Promise.all(
          images.map((a) =>
            describeImage(credentials, a.dataUrl as string, question),
          ),
        );
      } catch (error) {
        // The send steps back into the composer so the user can retry: the
        // message returns to the draft and the failed attachment says why.
        removeMessage(userMessageId);
        setDraft(typed);
        setAttachments(
          heldAttachments.map((a) =>
            images.some((i) => i.id === a.id)
              ? {
                  ...a,
                  status: "error" as const,
                  errorMessage:
                    error instanceof Error ? error.message : "failed",
                }
              : a,
          ),
        );
        setReadingImages(false);
        setPending(false);
        return;
      }
      setReadingImages(false);
      const substituted = images
        .map(
          (a, i) =>
            `[Attached image "${a.name}"]\n${(descriptions[i] ?? "").replace(/\n{2,}/g, "\n")}`,
        )
        .join("\n\n");
      prompt = [substituted, typed].filter(Boolean).join("\n\n");
      setMessageContent(userMessageId, prompt);
    }

    // Windowed prompt: summary stands in for the covered prefix, then the
    // most recent messages that fit the budget. The transcript on screen and
    // in the canister stays complete.
    const summary = summaryRef.current;
    const usable = messages.filter((m) => !m.error && m.content.length > 0);
    const afterSummary = summary ? usable.slice(summary.coversCount) : usable;
    let budget = PROMPT_CHAR_BUDGET - prompt.length;
    const recent: ChatMessage[] = [];
    for (let i = afterSummary.length - 1; i >= 0; i--) {
      const m = afterSummary[i];
      budget -= m.content.length;
      if (budget < 0 && recent.length > 0) break;
      recent.unshift({ role: m.role, content: m.content });
    }
    const turns: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...(summary
        ? [
            {
              role: "system" as const,
              content: `Summary of the ${summary.coversCount} earlier messages in this conversation:\n${summary.content}`,
            },
          ]
        : []),
      ...recent,
      { role: "user", content: prompt },
    ];

    try {
      const content = await complete(turns);
      persistExchange(prompt, content);
    } catch (error) {
      pushMessage({
        role: "assistant",
        content:
          error instanceof Error ? error.message : "Something went wrong.",
        error: true,
      });
    } finally {
      setPending(false);
    }
  }

  async function complete(turns: ChatMessage[]): Promise<string> {
    let credentials = credentialsQuery.data;
    let refreshedCredentials = false;
    // The tool loop mutates a working copy: each search appends the model's
    // tool call plus its result, then asks the model to continue. The
    // on-screen transcript and canister history keep only the final answer.
    const working: ChatMessage[] = [...turns];
    const sources: { title: string; url: string }[] = [];
    let toolIterations = 0;

    for (;;) {
      if (!credentials) {
        throw new Error(
          "Inference credentials not available yet — try again in a moment.",
        );
      }
      // Streamed call: the bubble exists from the first delta on and fills in
      // as tokens arrive.
      const streamingId = pushMessage({
        role: "assistant",
        content: "",
        streaming: true,
      });
      try {
        const offerTools = toolIterations < MAX_TOOL_ITERATIONS;
        const result: CompletionResult = await completeDirect(
          credentials,
          working,
          {
            tools: offerTools ? [WEB_SEARCH_TOOL] : undefined,
            onDelta: (delta) => appendToMessage(streamingId, delta),
            onReasoningDelta: (delta) => appendReasoning(streamingId, delta),
            reasoningEffort: thinkingEnabled ? "medium" : undefined,
          },
        );

        // The model chose to search instead of answering: run each search,
        // hand the results back as tool messages, and let it continue.
        if (result.toolCalls && result.toolCalls.length > 0) {
          removeMessage(streamingId);
          toolIterations += 1;
          working.push({
            role: "assistant",
            content: result.content,
            tool_calls: result.toolCalls,
          });
          for (const call of result.toolCalls) {
            let query = "";
            try {
              query = String(JSON.parse(call.function.arguments)?.query ?? "");
            } catch {
              // Malformed arguments: answer the tool with an error note.
            }
            setSearchingQuery(query || "…");
            let toolContent: string;
            try {
              if (call.function.name !== "web_search" || !query) {
                toolContent = "Error: unknown tool or missing query.";
              } else {
                const found: SearchResponse = await searchWeb(
                  credentials,
                  query,
                );
                for (const result of found.results) {
                  if (!sources.some((s) => s.url === result.url)) {
                    sources.push({ title: result.title, url: result.url });
                  }
                }
                toolContent =
                  found.results.length > 0
                    ? JSON.stringify(found.results)
                    : (found.text ?? "No results found.");
              }
            } catch (error) {
              toolContent = `Error: ${
                error instanceof Error ? error.message : "search failed"
              }`;
            } finally {
              setSearchingQuery(null);
            }
            working.push({
              role: "tool",
              content: toolContent,
              tool_call_id: call.id,
            });
          }
          continue;
        }

        finalizeMessage(streamingId, {
          content: result.content,
          sources: sources.length > 0 ? sources : undefined,
          meta: {
            latencyMs: result.latencyMs,
            firstTokenMs: result.firstTokenMs,
            tokensPerSecond: tokensPerSecond(result),
          },
        });
        return result.content;
      } catch (error) {
        removeMessage(streamingId);
        setSearchingQuery(null);
        // 401/403 can mean the key expired or rotated since we fetched it —
        // refresh the credentials once and retry.
        if (
          error instanceof GatewayError &&
          (error.status === 401 || error.status === 403) &&
          !refreshedCredentials
        ) {
          refreshedCredentials = true;
          credentials = (await credentialsQuery.refetch()).data;
          continue;
        }
        throw error;
      }
    }
  }

  const credentialsPending =
    credentialsQuery.isLoading && !credentialsQuery.data;
  const conversations = conversationsQuery.data ?? [];

  return (
    <div className="relative flex h-dvh bg-canvas text-ink">
      <aside
        className={clsx(
          "absolute inset-y-0 left-0 z-20 flex w-72 flex-col border-r border-hairline bg-canvas transition-transform md:static md:translate-x-0",
          sidebarOpen ? "translate-x-0 shadow-card" : "-translate-x-full",
        )}
      >
        <div className="flex items-center gap-2 px-4 py-3">
          <div className="flex size-8 items-center justify-center rounded-lg bg-brand-wash text-brand">
            <Zap className="size-4" />
          </div>
          <span className="text-[15px] font-medium text-ink">
            CaffeineChatBot
          </span>
        </div>
        <div className="px-3">
          <button
            type="button"
            onClick={startNewChat}
            className="flex w-full items-center justify-center gap-1.5 rounded-full border border-hairline bg-paper px-4 py-2 text-sm text-ink transition hover:bg-soft"
          >
            <Plus className="size-4" /> New chat
          </button>
        </div>
        <nav className="mt-3 min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          {conversations.length === 0 && (
            <p className="px-2 pt-2 text-xs text-muted">
              No chats yet. Your conversations are saved here.
            </p>
          )}
          {conversations.map((chat) => (
            <div
              key={String(chat.id)}
              className={clsx(
                "group mt-1 flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition",
                activeChatId === chat.id
                  ? "border border-hairline bg-paper text-ink"
                  : "text-body hover:bg-soft",
              )}
            >
              <button
                type="button"
                onClick={() => void openChat(chat.id)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <MessageSquare className="size-3.5 shrink-0 text-muted" />
                <span className="truncate">{chat.title}</span>
              </button>
              <button
                type="button"
                onClick={() => void deleteChat(chat.id)}
                aria-label="Delete chat"
                className="hidden shrink-0 text-muted transition hover:text-red-600 group-hover:block"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </nav>
        <div className="border-t border-hairline px-4 py-3 text-[11px] leading-relaxed text-muted">
          <p className="font-medium text-body">Pricing</p>
          <p>Chat costs $0.22 / $0.05 / $0.50 per Mtok (in / cached / out).</p>
          <p>A web search costs $0.01.</p>
          <p>Reading an image costs $0.01.</p>
          <a
            href="https://caffeine.ai/inference"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-muted underline decoration-hairline underline-offset-2 transition hover:text-ink"
          >
            Powered by Caffeine Inference
          </a>
        </div>
      </aside>
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close sidebar"
          className="absolute inset-0 z-10 bg-ink/20 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div
        className="relative flex min-w-0 flex-1 flex-col"
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDragActive(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragActive(false);
          attachImages(event.dataTransfer.files);
        }}
      >
        {dragActive && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-brand bg-canvas/80">
            <span className="flex items-center gap-2 text-sm text-ink">
              <ImageIcon className="size-5 text-brand" /> Drop an image to
              attach it
            </span>
          </div>
        )}
        <header className="flex items-center justify-between border-b border-hairline bg-canvas px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              aria-label="Toggle chat list"
              onClick={() => setSidebarOpen((open) => !open)}
              className="flex size-8 items-center justify-center rounded-lg text-muted transition hover:bg-soft md:hidden"
            >
              <PanelLeft className="size-4" />
            </button>
            <ConnectionBadge
              credentialsPending={credentialsPending}
              credentialsError={credentialsQuery.isError}
            />
          </div>
          <button
            type="button"
            onClick={() => clear()}
            className="flex items-center gap-1.5 rounded-full border border-hairline bg-paper px-3 py-1.5 text-xs text-body transition hover:bg-soft"
          >
            <LogOut className="size-3.5" /> Sign out
          </button>
        </header>

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-6"
        >
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            {credentialsQuery.isError && (
              <div className="mx-auto mt-8 max-w-md rounded-[20px] border border-hairline bg-paper p-5 text-sm shadow-card">
                <p className="font-medium text-red-600">Could not connect</p>
                <p className="mt-1 break-words text-xs text-muted">
                  {trapMessage(credentialsQuery.error)}
                </p>
                <button
                  type="button"
                  onClick={() => void credentialsQuery.refetch()}
                  className="mt-3 rounded-full border border-hairline bg-paper px-4 py-1.5 text-xs text-ink transition hover:bg-soft"
                >
                  Try again
                </button>
              </div>
            )}
            {messages.length === 0 && !credentialsQuery.isError && (
              <div className="mt-20 text-center">
                <h2 className="font-display text-4xl tracking-[-0.04em] text-ink">
                  Ask <em>anything</em>.
                </h2>
                <p className="mt-3 text-sm text-muted">
                  {credentialsPending
                    ? "Getting ready…"
                    : "Your personal chatbot. Drop in an image, or just ask."}
                </p>
              </div>
            )}
            {messages
              .filter(
                (m) => !(m.streaming && m.content.length === 0 && !m.reasoning),
              )
              .map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}
            {pending &&
              !messages.some(
                (m) => m.streaming && (m.content.length > 0 || m.reasoning),
              ) && (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <Loader2 className="size-4 animate-spin" />
                  {searchingQuery !== null ? (
                    <>
                      <Globe className="size-3.5" /> Searching: {searchingQuery}
                    </>
                  ) : readingImages ? (
                    <>
                      <ImageIcon className="size-3.5" /> Reading image…
                    </>
                  ) : (
                    "Thinking…"
                  )}
                </div>
              )}
          </div>
        </div>

        <footer className="border-t border-hairline bg-canvas px-4 py-4">
          {attachments.length > 0 && (
            <div className="mx-auto mb-2 flex max-w-2xl flex-wrap gap-1.5">
              {attachments.map((attachment) => (
                <span
                  key={attachment.id}
                  title={
                    attachment.status === "error"
                      ? attachment.errorMessage
                      : attachment.name
                  }
                  className={clsx(
                    "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                    attachment.status === "error"
                      ? "border-red-300 bg-red-50 text-red-600"
                      : "border-hairline bg-paper text-muted",
                  )}
                >
                  {attachment.status === "describing" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <ImageIcon className="size-3" />
                  )}
                  <span className="max-w-40 truncate">{attachment.name}</span>
                  {attachment.status === "describing" && "— reading…"}
                  {attachment.status === "error" &&
                    `— ${attachment.errorMessage}`}
                  <button
                    type="button"
                    onClick={() => removeAttachment(attachment.id)}
                    aria-label={`Remove ${attachment.name}`}
                    className="text-muted transition hover:text-ink"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <form
            className="mx-auto flex max-w-2xl flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <div className="order-3 flex w-full shrink-0 items-center gap-1 lg:order-none lg:w-auto">
              <button
                type="button"
                role="switch"
                aria-checked={thinkingEnabled}
                onClick={() => setThinkingEnabled((on) => !on)}
                title="When on, the model reasons before answering and shows its trace"
                className="flex h-11 shrink-0 items-center gap-2 rounded-full px-2.5 text-xs outline-none transition hover:bg-soft focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                <span
                  className={clsx(
                    "relative inline-block h-[18px] w-8 shrink-0 rounded-full transition-colors",
                    thinkingEnabled ? "bg-brand" : "bg-softline",
                  )}
                >
                  <span
                    className={clsx(
                      "absolute left-0.5 top-0.5 size-3.5 rounded-full bg-white shadow-sm transition-transform",
                      thinkingEnabled && "translate-x-3.5",
                    )}
                  />
                </span>
                <span className={thinkingEnabled ? "text-ink" : "text-muted"}>
                  Enable thinking
                </span>
              </button>
            </div>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              rows={1}
              placeholder="Message CaffeineChatBot…"
              className="order-1 max-h-40 min-h-[2.75rem] min-w-0 flex-1 resize-y rounded-3xl border border-hairline bg-soft px-4 py-2.5 text-[15px] text-ink outline-none transition placeholder:text-placeholder focus:border-brand focus:bg-paper lg:order-none"
            />
            <button
              type="submit"
              disabled={
                pending ||
                attachments.some((a) => a.status === "describing") ||
                (!draft.trim() &&
                  !attachments.some((a) => a.status === "ready"))
              }
              className="order-2 flex size-11 shrink-0 items-center justify-center rounded-full bg-brand text-white transition hover:bg-brand-hover disabled:opacity-40 lg:order-none"
              aria-label="Send"
            >
              <Send className="size-4" />
            </button>
          </form>
        </footer>
      </div>
    </div>
  );
}

function ConnectionBadge({
  credentialsPending,
  credentialsError,
}: {
  credentialsPending: boolean;
  credentialsError: boolean;
}) {
  let label: string;
  let dot: string;
  if (credentialsPending) {
    label = "connecting…";
    dot = "bg-placeholder";
  } else if (credentialsError) {
    label = "connection failed";
    dot = "bg-red-500";
  } else {
    label = "connected to Caffeine Inference";
    dot = "bg-brand";
  }
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-hairline bg-paper px-2.5 py-1 text-[11px] text-muted">
      <span className={clsx("size-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
}

function MessageBubble({ message }: { message: DisplayMessage }) {
  const isUser = message.role === "user";
  const user = isUser ? parseUserContent(message.content) : null;
  return (
    <div
      className={clsx("flex flex-col", isUser ? "items-end" : "items-start")}
    >
      {!isUser && message.reasoning && (
        <details
          open={message.streaming}
          className="mb-1.5 max-w-[85%] rounded-xl border border-hairline bg-soft px-3.5 py-2 text-xs text-muted"
        >
          <summary className="cursor-pointer select-none font-medium">
            {message.streaming ? "Thinking…" : "Thinking trace"}
          </summary>
          <p className="mt-1.5 whitespace-pre-wrap leading-relaxed">
            {message.reasoning}
          </p>
        </details>
      )}
      {user && user.images.length > 0 && (
        <div className="mb-1.5 flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {user.images.map((name, i) => (
            <span
              key={`${name}-${user.images.slice(0, i).filter((n) => n === name).length}`}
              className="flex items-center gap-1 rounded-full border border-hairline bg-paper px-2.5 py-1 text-[11px] text-muted"
            >
              <ImageIcon className="size-3 shrink-0" />
              <span className="max-w-44 truncate">{name}</span>
            </span>
          ))}
        </div>
      )}
      {(message.error ||
        (user ? user.text.length > 0 : message.content.length > 0)) && (
        <div
          className={clsx(
            "max-w-[85%] rounded-[20px] px-4 py-2.5 text-sm leading-relaxed",
            isUser
              ? "whitespace-pre-wrap bg-ink text-canvas"
              : message.error
                ? "whitespace-pre-wrap border border-red-200 bg-red-50 text-red-700"
                : "markdown-body border border-hairline bg-paper",
          )}
        >
          {isUser || message.error ? (
            user && !message.error ? (
              user.text
            ) : (
              message.content
            )
          ) : (
            // Assistant replies are Markdown. Raw HTML in the model output is
            // NOT rendered (react-markdown default), so this stays XSS-safe.
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: (props) => (
                  <a {...props} target="_blank" rel="noopener noreferrer" />
                ),
              }}
            >
              {message.content}
            </Markdown>
          )}
        </div>
      )}
      {message.sources && message.sources.length > 0 && (
        <div className="mt-1.5 flex max-w-[85%] flex-wrap gap-1.5">
          {message.sources.map((source) => (
            <a
              key={source.url}
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              title={source.url}
              className="flex items-center gap-1 rounded-full border border-hairline bg-paper px-2.5 py-1 text-[11px] text-muted transition hover:bg-soft hover:text-ink"
            >
              <Globe className="size-3 shrink-0" />
              <span className="max-w-44 truncate">
                {source.title || new URL(source.url).hostname}
              </span>
            </a>
          ))}
        </div>
      )}
      {message.meta && (
        <span className="mt-1 px-1 text-[11px] lowercase tracking-wide text-muted [font-variant-caps:small-caps]">
          {message.meta.firstTokenMs !== undefined &&
            message.meta.firstTokenMs !== message.meta.latencyMs &&
            `first token ${formatMs(message.meta.firstTokenMs)} · `}
          {`${formatMs(message.meta.latencyMs)} total`}
          {message.meta.tokensPerSecond !== undefined &&
            ` · ${message.meta.tokensPerSecond} tok/s`}
        </span>
      )}
    </div>
  );
}
