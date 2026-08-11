import { AIProviderError, type AIProviderName } from "./provider";

export interface SafeAIHttpOptions {
  provider: Exclude<AIProviderName, "none" | "anthropic">;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}

export interface SafeAIHttpResponse {
  status: number;
  data: unknown;
}

/**
 * AI 接口地址只允许来自服务端配置；禁止 URL 凭据、片段和非 HTTP 协议。
 * 私网地址不能一概拦截，因为 Ollama 与企业兼容接口通常就在本机或内网。
 */
function configuredUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("AI 接口地址无法解析");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("AI 接口仅允许 HTTP/HTTPS");
  if (url.username || url.password) throw new Error("AI 接口地址不得携带凭据");
  if (url.hash) throw new Error("AI 接口地址不得包含片段");
  if (!url.hostname) throw new Error("AI 接口缺少主机名");
  return url;
}

export function resolveOpenAIChatEndpoint(baseUrl: string): string {
  const url = configuredUrl(baseUrl);
  if (url.search) throw new Error("OpenAI 兼容接口基础地址不得包含查询参数");
  let path = url.pathname.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(path)) {
    url.pathname = path;
    return url.toString();
  }
  path = /\/v1$/i.test(path) ? `${path}/chat/completions` : `${path}/v1/chat/completions`;
  url.pathname = path.replace(/\/+/g, "/");
  return url.toString();
}

export function resolveOllamaChatEndpoint(baseUrl: string): string {
  const url = configuredUrl(baseUrl);
  if (url.search) throw new Error("Ollama 基础地址不得包含查询参数");
  let path = url.pathname.replace(/\/+$/, "");
  if (!/\/api\/chat$/i.test(path)) path = /\/api$/i.test(path) ? `${path}/chat` : `${path}/api/chat`;
  url.pathname = path.replace(/\/+/g, "/");
  return url.toString();
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("AI 响应体超过大小限制");
  if (!response.body) return response.text();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("AI 响应体超过大小限制");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(body);
}

function apiErrorMessage(data: unknown, fallback: string): string {
  if (typeof data === "object" && data !== null) {
    const record = data as Record<string, unknown>;
    if (typeof record.error === "string") return record.error.slice(0, 500);
    if (typeof record.error === "object" && record.error !== null) {
      const message = (record.error as Record<string, unknown>).message;
      if (typeof message === "string") return message.slice(0, 500);
    }
    if (typeof record.message === "string") return record.message.slice(0, 500);
  }
  return fallback;
}

/** 安全的服务端 JSON POST：固定目的地址、禁止重定向、超时、响应限长 */
export async function safeAIJsonPost(
  url: string,
  body: unknown,
  options: SafeAIHttpOptions
): Promise<SafeAIHttpResponse> {
  const endpoint = configuredUrl(url).toString();
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 90_000, 10 * 60_000));
  const maxBytes = Math.max(16_384, Math.min(options.maxResponseBytes ?? 2 * 1024 * 1024, 8 * 1024 * 1024));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("AI 请求超时")), timeoutMs);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await (options.fetchFn ?? fetch)(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...options.headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await readLimitedText(response, maxBytes);
    let data: unknown = null;
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new AIProviderError("AI 接口返回了无效 JSON", {
          code: "invalid_response",
          provider: options.provider,
          status: response.status,
        });
      }
    }

    if (!response.ok) {
      throw new AIProviderError(apiErrorMessage(data, `AI 接口返回 HTTP ${response.status}`), {
        code: "http",
        provider: options.provider,
        status: response.status,
        retryable: response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
      });
    }
    return { status: response.status, data };
  } catch (error) {
    if (error instanceof AIProviderError) throw error;
    const message = controller.signal.aborted ? "AI 请求已取消或超时" : "AI 网络请求失败";
    throw new AIProviderError(message, {
      code: "http",
      provider: options.provider,
      retryable: !options.signal?.aborted,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
