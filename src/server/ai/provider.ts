export type AIProviderName = "none" | "anthropic" | "openai" | "ollama";
export type AIResponseMode = "text" | "json";

/** AI 生成请求；系统提示与动态输入分离，便于安全控制和提示词缓存 */
export interface AIGenerateRequest {
  system: string;
  prompt: string;
  mode?: AIResponseMode;
  maxTokens?: number;
  jsonSchema?: Record<string, unknown>;
  cacheSystem?: boolean;
  signal?: AbortSignal;
}

/** 统一后的模型响应，调用方不依赖具体厂商响应结构 */
export interface AIGenerateResult {
  text: string;
  provider: AIProviderName;
  model: string;
  finishReason: string | null;
  inputTokens?: number;
  outputTokens?: number;
  fallbackUsed?: boolean;
}

/** 所有 AI 提供方都实现同一最小接口 */
export interface AIProvider {
  readonly name: AIProviderName;
  readonly model: string;
  readonly enabled: boolean;
  generate(request: AIGenerateRequest): Promise<AIGenerateResult>;
}

export type AIErrorCode = "unavailable" | "http" | "refusal" | "invalid_response" | "truncated";

/** 对外只保留可安全记录的错误信息，避免把密钥或完整响应写入日志 */
export class AIProviderError extends Error {
  readonly code: AIErrorCode;
  readonly provider: AIProviderName;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      code: AIErrorCode;
      provider: AIProviderName;
      status?: number;
      retryable?: boolean;
      cause?: unknown;
    }
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AIProviderError";
    this.code = options.code;
    this.provider = options.provider;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

/** 拒绝属于正常的内容结果，不得在读取 content 后才处理 */
export class AIRefusalError extends AIProviderError {
  readonly category: string | null;

  constructor(provider: AIProviderName, category: string | null, explanation?: string | null) {
    super(explanation?.trim() || "AI 提供方拒绝处理该请求", {
      code: "refusal",
      provider,
      retryable: false,
    });
    this.name = "AIRefusalError";
    this.category = category;
  }
}

/** 未配置或显式关闭 AI 时使用；该错误不会触发任何网络请求 */
export class AIUnavailableError extends AIProviderError {
  constructor(provider: AIProviderName = "none", message = "AI 未启用") {
    super(message, { code: "unavailable", provider, retryable: false });
    this.name = "AIUnavailableError";
  }
}

export interface AIOrExtractiveResult<T> {
  value: T;
  engine: "ai" | "extractive";
  /** 仅供服务端诊断，不应直接暴露给前端 */
  aiError?: string;
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 500) || "AI 生成失败";
}

/**
 * 统一执行“AI 生成 → 防御性校验 → 抽取式降级”。
 * 校验器返回 null 即视为模型输出不可信或结构不完整。
 */
export async function runAIOrExtractive<T>(
  provider: AIProvider | null | undefined,
  request: AIGenerateRequest,
  validate: (text: string) => T | null,
  fallback: () => T
): Promise<AIOrExtractiveResult<T>> {
  if (!provider?.enabled || provider.name === "none") {
    return { value: fallback(), engine: "extractive" };
  }

  try {
    const generated = await provider.generate(request);
    const value = validate(generated.text);
    if (value === null) {
      throw new AIProviderError("AI 输出未通过结构与引用校验", {
        code: "invalid_response",
        provider: provider.name,
      });
    }
    return { value, engine: "ai" };
  } catch (error) {
    return { value: fallback(), engine: "extractive", aiError: safeErrorMessage(error) };
  }
}
