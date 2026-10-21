// Browser-side Caffeine Inference client.
//
// The backend hands signed-in users the app's inference endpoint + API key
// (see backend getInferenceCredentials). This module holds those credentials
// in memory only — never in localStorage, sessionStorage, cookies, or URLs —
// and calls the gateway's OpenAI-compatible chat-completions route directly
// from the browser.

export interface InferenceCredentials {
  baseUrl: string;
  apiKey: string;
  /** RFC 3339 expiry of the ephemeral key; absent for dev credentials. */
  expiresAt?: string;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** A tool invocation the model asked for (OpenAI chat shape). */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** On an assistant message: the tool calls it made, echoed back. */
  tool_calls?: ToolCall[];
  /** On a tool message: which call this is the result of. */
  tool_call_id?: string;
}

export interface CompletionResult {
  content: string;
  /** Tool calls the model requested instead of (or before) answering. */
  toolCalls?: ToolCall[];
  finishReason?: string;
  latencyMs: number;
  /** Time to first streamed token; equals latencyMs for non-streamed calls. */
  firstTokenMs?: number;
  /** Output tokens as counted by the gateway's usage frame, when sent. */
  outputTokens?: number;
  /** The model's reasoning trace, when the request enabled reasoning and the
   * model produced one. */
  reasoning?: string;
}

export interface CompletionOptions {
  /** Function tools offered to the model (OpenAI chat `tools` shape). */
  tools?: unknown[];
  onDelta?: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
  /** Sent as `reasoning_effort`; the gateway forwards it to reasoning-capable
   * models. */
  reasoningEffort?: string;
  signal?: AbortSignal;
}

/** Error carrying the gateway's HTTP status, so callers can distinguish
 * auth/quota failures (no point retrying) from transport failures (fall back
 * to the backend relay). */
export class GatewayError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * In dev the browser calls the gateway same-origin through the Vite proxy
 * (`/inference-proxy`, see vite.config.js) because the gateway does not
 * answer CORS preflights. Production builds call the gateway directly.
 */
export function gatewayBaseUrl(credentials: InferenceCredentials): string {
  if (import.meta.env.DEV) {
    return "/inference-proxy";
  }
  return credentials.baseUrl.replace(/\/+$/, "");
}

/**
 * Dev-only convenience: `VITE_DEV_INFERENCE_KEY=ci_... pnpm dev` lets the
 * chat run against the proxied gateway without a local replica providing the
 * backend credential endpoint. Compiled out of production builds.
 */
export function devCredentials(): InferenceCredentials | null {
  if (!import.meta.env.DEV) {
    return null;
  }
  const key = import.meta.env.VITE_DEV_INFERENCE_KEY;
  if (typeof key !== "string" || key.length === 0) {
    return null;
  }
  return { baseUrl: "", apiKey: key };
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  published_date?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  /** Bounded plain-text results when the provider answered prose; the model
   * consumes it directly. */
  text?: string;
}

/**
 * One web search via the gateway (`POST /v1/search`, app keys only). The
 * gateway hides the provider and bills the app a flat fee per search.
 */
export async function searchWeb(
  credentials: InferenceCredentials,
  query: string,
  numResults = 5,
): Promise<SearchResponse> {
  const response = await fetch(`${gatewayBaseUrl(credentials)}/v1/search`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${credentials.apiKey}`,
    },
    body: JSON.stringify({
      query: query.slice(0, 500),
      num_results: numResults,
    }),
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new GatewayError(404, "Web search is not enabled for this app.");
    }
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body?.error?.message === "string") {
        detail = body.error.message;
      }
    } catch {
      // Non-JSON error body; keep the status text.
    }
    throw new GatewayError(response.status, detail);
  }
  const body = await response.json();
  return {
    results: Array.isArray(body?.results) ? body.results : [],
    text: typeof body?.text === "string" ? body.text : undefined,
  };
}

/** An attached image, at most this many bytes, rides to the vision bridge. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Turn an image into text via the gateway's vision bridge
 * (`POST /v1/images/describe`, allowlisted per project). The image goes up as
 * a base64 data URL and comes back as a plain-text description; nothing is
 * stored server-side. The chat itself stays text-only — the caller substitutes
 * this description for the image locally.
 */
export async function describeImage(
  credentials: InferenceCredentials,
  imageDataUrl: string,
  question?: string,
): Promise<string> {
  const response = await fetch(
    `${gatewayBaseUrl(credentials)}/v1/images/describe`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credentials.apiKey}`,
      },
      body: JSON.stringify({
        image: imageDataUrl,
        ...(question ? { question } : {}),
      }),
    },
  );
  if (!response.ok) {
    // The gateway answers 404 for apps not on the vision allowlist — to the
    // user that simply means the feature is off, not that a URL broke.
    if (response.status === 404) {
      throw new GatewayError(
        404,
        "Image understanding is not enabled for this app.",
      );
    }
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body?.error?.message === "string") {
        detail = body.error.message;
      }
    } catch {
      // Non-JSON error body; keep the status text.
    }
    throw new GatewayError(response.status, detail);
  }
  const body = await response.json();
  if (typeof body?.description !== "string" || body.description.length === 0) {
    throw new Error("Vision service returned no description");
  }
  return body.description;
}

/**
 * One chat completion, straight from the browser to the gateway, streamed.
 * `onDelta` receives each content fragment as it arrives so the UI can render
 * the reply token by token; the resolved result carries the full text plus
 * time-to-first-token and total latency.
 */
export async function completeDirect(
  credentials: InferenceCredentials,
  messages: ChatMessage[],
  options: CompletionOptions = {},
): Promise<CompletionResult> {
  const { tools, onDelta, onReasoningDelta, reasoningEffort, signal } = options;
  const started = performance.now();
  const response = await fetch(
    `${gatewayBaseUrl(credentials)}/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credentials.apiKey}`,
      },
      body: JSON.stringify({
        model: "router",
        messages,
        stream: true,
        // The gateway then appends a final usage chunk (empty choices), which
        // is what makes an honest tokens/s figure possible.
        stream_options: { include_usage: true },
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }),
      signal,
    },
  );
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body?.error?.message === "string") {
        detail = body.error.message;
      }
    } catch {
      // Non-JSON error body; keep the status text.
    }
    throw new GatewayError(response.status, detail);
  }
  // A server that ignored `stream` answers with a plain JSON completion.
  if (response.headers.get("content-type")?.includes("application/json")) {
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("Inference returned no text content");
    }
    onDelta?.(content);
    const latencyMs = Math.round(performance.now() - started);
    const jsonReasoning =
      body?.choices?.[0]?.message?.reasoning_content ??
      body?.choices?.[0]?.message?.reasoning;
    return {
      content,
      latencyMs,
      firstTokenMs: latencyMs,
      outputTokens: body?.usage?.completion_tokens,
      reasoning: typeof jsonReasoning === "string" ? jsonReasoning : undefined,
    };
  }

  if (!response.body) {
    throw new Error("Inference response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let content = "";
  let reasoning = "";
  let firstTokenMs: number | undefined;
  let outputTokens: number | undefined;
  let finishReason: string | undefined;
  // Tool-call fragments stream in by index; arguments arrive as concatenated
  // JSON pieces that only parse once the stream is done.
  const toolCallParts = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    // SSE events are separated by a blank line; keep the trailing partial
    // event in the buffer until its terminator arrives.
    const events = buffered.split("\n\n");
    buffered = events.pop() ?? "";
    for (const event of events) {
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let chunk: any;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        const usage = chunk?.usage?.completion_tokens;
        if (typeof usage === "number") {
          outputTokens = usage;
        }
        const chunkFinish = chunk?.choices?.[0]?.finish_reason;
        if (typeof chunkFinish === "string" && chunkFinish.length > 0) {
          finishReason = chunkFinish;
        }
        const toolDeltas = chunk?.choices?.[0]?.delta?.tool_calls;
        if (Array.isArray(toolDeltas)) {
          for (const delta of toolDeltas) {
            const index = typeof delta?.index === "number" ? delta.index : 0;
            const part = toolCallParts.get(index) ?? {
              id: "",
              name: "",
              arguments: "",
            };
            if (typeof delta?.id === "string") part.id = delta.id;
            if (typeof delta?.function?.name === "string") {
              part.name += delta.function.name;
            }
            if (typeof delta?.function?.arguments === "string") {
              part.arguments += delta.function.arguments;
            }
            toolCallParts.set(index, part);
          }
        }
        // Upstreams name the reasoning stream differently; the gateway passes
        // both through.
        const reasoningDelta =
          chunk?.choices?.[0]?.delta?.reasoning_content ??
          chunk?.choices?.[0]?.delta?.reasoning;
        if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
          if (firstTokenMs === undefined) {
            firstTokenMs = Math.round(performance.now() - started);
          }
          reasoning += reasoningDelta;
          onReasoningDelta?.(reasoningDelta);
        }
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          if (firstTokenMs === undefined) {
            firstTokenMs = Math.round(performance.now() - started);
          }
          content += delta;
          onDelta?.(delta);
        }
      }
    }
  }
  const toolCalls: ToolCall[] = [...toolCallParts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, part]) => ({
      id: part.id,
      type: "function" as const,
      function: { name: part.name, arguments: part.arguments },
    }))
    .filter((call) => call.id.length > 0 && call.function.name.length > 0);
  if (content.length === 0 && toolCalls.length === 0) {
    throw new Error("Inference returned no text content");
  }
  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
    latencyMs: Math.round(performance.now() - started),
    firstTokenMs,
    outputTokens,
    reasoning: reasoning.length > 0 ? reasoning : undefined,
  };
}
