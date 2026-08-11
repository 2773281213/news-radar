import { isRecord } from "./json";
import { resolveOpenAIChatEndpoint, safeAIJsonPost } from "./http";
import {
  AIProviderError,
  AIRefusalError,
  AIUnavailableError,
  type AIGenerateRequest,
  type AIGenerateResult,
  type AIProvider,
} from "./provider";

export interface OpenAICompatibleProviderOptions {
  baseURL: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchFn?: typeof fetch;
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** OpenAI Chat Completions 兼容接口，仅在服务端发送密钥 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly name = "openai" as const;
  readonly model: string;
  readonly enabled: boolean;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs?: number;
  private readonly maxResponseBytes?: number;
  private readonly fetchFn?: typeof fetch;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.model = options.model.trim();
    this.apiKey = options.apiKey?.trim() || "";
    this.enabled = Boolean(options.baseURL.trim() && this.model);
    this.endpoint = options.baseURL.trim() ? resolveOpenAIChatEndpoint(options.baseURL.trim()) : "http://invalid.invalid/v1/chat/completions";
    this.timeoutMs = options.timeoutMs;
    this.maxResponseBytes = options.maxResponseBytes;
    this.fetchFn = options.fetchFn;
  }

  async generate(request: AIGenerateRequest): Promise<AIGenerateResult> {
    if (!this.enabled) throw new AIUnavailableError(this.name, "OpenAI 兼容接口缺少基础地址或模型名");
    const maxTokens = Math.max(128, Math.min(request.maxTokens ?? 8_192, 128_000));
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
      max_tokens: maxTokens,
      stream: false,
      ...(request.mode === "json" ? { response_format: { type: "json_object" } } : {}),
    };
    const response = await safeAIJsonPost(this.endpoint, body, {
      provider: this.name,
      headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : undefined,
      timeoutMs: this.timeoutMs,
      maxResponseBytes: this.maxResponseBytes,
      signal: request.signal,
      fetchFn: this.fetchFn,
    });

    if (!isRecord(response.data)) {
      throw new AIProviderError("OpenAI 兼容接口响应不是对象", {
        code: "invalid_response",
        provider: this.name,
      });
    }
    const choices = response.data.choices;
    if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) {
      throw new AIProviderError("OpenAI 兼容接口缺少 choices", {
        code: "invalid_response",
        provider: this.name,
      });
    }
    const choice = choices[0];
    const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
    if (finishReason === "content_filter") throw new AIRefusalError(this.name, "content_filter");
    if (finishReason === "length") {
      throw new AIProviderError("OpenAI 兼容接口输出被截断", {
        code: "truncated",
        provider: this.name,
      });
    }
    if (!isRecord(choice.message)) {
      throw new AIProviderError("OpenAI 兼容接口缺少 assistant message", {
        code: "invalid_response",
        provider: this.name,
      });
    }
    const refusal = choice.message.refusal;
    if (typeof refusal === "string" && refusal.trim()) throw new AIRefusalError(this.name, null, refusal);

    const text = messageText(choice.message);
    if (!text) {
      throw new AIProviderError("OpenAI 兼容接口没有返回文本", {
        code: "invalid_response",
        provider: this.name,
      });
    }
    const usage = isRecord(response.data.usage) ? response.data.usage : null;
    return {
      text,
      provider: this.name,
      model: typeof response.data.model === "string" ? response.data.model : this.model,
      finishReason,
      inputTokens: usage && typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
      outputTokens: usage && typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
    };
  }
}

export const OpenAIProvider = OpenAICompatibleProvider;
