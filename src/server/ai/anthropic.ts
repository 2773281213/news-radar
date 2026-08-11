import Anthropic from "@anthropic-ai/sdk";
import {
  AIProviderError,
  AIRefusalError,
  type AIGenerateRequest,
  type AIGenerateResult,
  type AIProvider,
} from "./provider";

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  timeoutMs?: number;
  client?: Anthropic;
}

const DEFAULT_MODEL = "claude-opus-5";
const FALLBACK_MODELS = new Set(["claude-opus-5", "claude-fable-5", "claude-mythos-5"]);

/** 使用 Anthropic 官方 SDK；不通过 OpenAI 兼容层调用 Claude */
export class AnthropicAIProvider implements AIProvider {
  readonly name = "anthropic" as const;
  readonly model: string;
  readonly enabled = true;
  private readonly client: Anthropic;

  constructor(options: AnthropicProviderOptions = {}) {
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.client =
      options.client ??
      new Anthropic({
        ...(options.apiKey?.trim() ? { apiKey: options.apiKey.trim() } : {}),
        ...(options.baseURL?.trim() ? { baseURL: options.baseURL.trim().replace(/\/$/, "") } : {}),
        timeout: options.timeoutMs ?? 120_000,
        maxRetries: 2,
      });
  }

  async generate(request: AIGenerateRequest): Promise<AIGenerateResult> {
    const maxTokens = Math.max(256, Math.min(request.maxTokens ?? 8_192, 128_000));
    const system =
      request.cacheSystem === false
        ? request.system
        : [
            {
              type: "text" as const,
              text: request.system,
              cache_control: { type: "ephemeral" as const },
            },
          ];
    const outputConfig = {
      effort: "high" as const,
      ...(request.mode === "json" && request.jsonSchema
        ? { format: { type: "json_schema" as const, schema: request.jsonSchema } }
        : {}),
    };
    const common = {
      model: this.model,
      max_tokens: maxTokens,
      thinking: { type: "adaptive" as const },
      output_config: outputConfig,
      system,
      messages: [{ role: "user" as const, content: request.prompt }],
    };

    try {
      const response = FALLBACK_MODELS.has(this.model)
        ? await this.client.beta.messages.create(
            {
              ...common,
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default",
            },
            request.signal ? { signal: request.signal } : undefined
          )
        : await this.client.beta.messages.create(common, request.signal ? { signal: request.signal } : undefined);

      // 必须先检查拒绝，再读取 content；拒绝响应可能没有任何内容块。
      if (response.stop_reason === "refusal") {
        throw new AIRefusalError(
          this.name,
          response.stop_details?.category ?? null,
          response.stop_details?.explanation ?? null
        );
      }
      if (response.stop_reason === "max_tokens" || response.stop_reason === "model_context_window_exceeded") {
        throw new AIProviderError("Claude 输出被令牌上限截断", {
          code: "truncated",
          provider: this.name,
        });
      }

      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (!text) {
        throw new AIProviderError("Claude 响应中没有可用文本", {
          code: "invalid_response",
          provider: this.name,
        });
      }

      const usage = response.usage;
      const inputTokens =
        usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      return {
        text,
        provider: this.name,
        model: response.model,
        finishReason: response.stop_reason,
        inputTokens,
        outputTokens: usage.output_tokens,
        fallbackUsed:
          response.model !== this.model || response.content.some((block) => block.type === "fallback"),
      };
    } catch (error) {
      if (error instanceof AIProviderError) throw error;
      if (error instanceof Anthropic.APIError) {
        throw new AIProviderError(`Anthropic API 请求失败（${error.status ?? "网络"}）`, {
          code: "http",
          provider: this.name,
          status: error.status,
          retryable: error.status === undefined || error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500,
          cause: error,
        });
      }
      throw new AIProviderError("Anthropic SDK 调用失败", {
        code: "http",
        provider: this.name,
        retryable: true,
        cause: error,
      });
    }
  }
}

export const AnthropicProvider = AnthropicAIProvider;
