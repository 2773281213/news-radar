import { resolveOllamaChatEndpoint, safeAIJsonPost } from "./http";
import { isRecord } from "./json";
import {
  AIProviderError,
  AIUnavailableError,
  type AIGenerateRequest,
  type AIGenerateResult,
  type AIProvider,
} from "./provider";

export interface OllamaProviderOptions {
  baseURL: string;
  model: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchFn?: typeof fetch;
}

/** Ollama 原生 /api/chat 提供方；允许由服务端配置连接本机或受信任内网 */
export class OllamaAIProvider implements AIProvider {
  readonly name = "ollama" as const;
  readonly model: string;
  readonly enabled: boolean;
  private readonly endpoint: string;
  private readonly timeoutMs?: number;
  private readonly maxResponseBytes?: number;
  private readonly fetchFn?: typeof fetch;

  constructor(options: OllamaProviderOptions) {
    this.model = options.model.trim();
    this.enabled = Boolean(options.baseURL.trim() && this.model);
    this.endpoint = options.baseURL.trim() ? resolveOllamaChatEndpoint(options.baseURL.trim()) : "http://invalid.invalid/api/chat";
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000;
    this.maxResponseBytes = options.maxResponseBytes;
    this.fetchFn = options.fetchFn;
  }

  async generate(request: AIGenerateRequest): Promise<AIGenerateResult> {
    if (!this.enabled) throw new AIUnavailableError(this.name, "Ollama 缺少基础地址或模型名");
    const maxTokens = Math.max(128, Math.min(request.maxTokens ?? 8_192, 128_000));
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
      stream: false,
      ...(request.mode === "json" ? { format: request.jsonSchema ?? "json" } : {}),
      options: { num_predict: maxTokens },
    };
    const response = await safeAIJsonPost(this.endpoint, body, {
      provider: this.name,
      timeoutMs: this.timeoutMs,
      maxResponseBytes: this.maxResponseBytes,
      signal: request.signal,
      fetchFn: this.fetchFn,
    });

    if (!isRecord(response.data) || !isRecord(response.data.message)) {
      throw new AIProviderError("Ollama 响应缺少 message", {
        code: "invalid_response",
        provider: this.name,
      });
    }
    const doneReason = typeof response.data.done_reason === "string" ? response.data.done_reason : null;
    if (doneReason === "length") {
      throw new AIProviderError("Ollama 输出被截断", {
        code: "truncated",
        provider: this.name,
      });
    }
    if (response.data.done === false) {
      throw new AIProviderError("Ollama 返回了未完成的非流式响应", {
        code: "invalid_response",
        provider: this.name,
      });
    }

    const content = response.data.message.content;
    const text = typeof content === "string" ? content.trim() : "";
    if (!text) {
      throw new AIProviderError("Ollama 没有返回可用文本", {
        code: "invalid_response",
        provider: this.name,
      });
    }
    return {
      text,
      provider: this.name,
      model: typeof response.data.model === "string" ? response.data.model : this.model,
      finishReason: doneReason,
      inputTokens: typeof response.data.prompt_eval_count === "number" ? response.data.prompt_eval_count : undefined,
      outputTokens: typeof response.data.eval_count === "number" ? response.data.eval_count : undefined,
    };
  }
}

export const OllamaProvider = OllamaAIProvider;
