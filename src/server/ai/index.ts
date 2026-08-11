import type Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config";
import { AnthropicAIProvider } from "./anthropic";
import { NoneAIProvider } from "./none";
import { OllamaAIProvider } from "./ollama";
import { OpenAICompatibleProvider } from "./openai";
import type { AIProvider } from "./provider";

export interface AIProviderDependencies {
  fetchFn?: typeof fetch;
  anthropicClient?: Anthropic;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export type AIProviderConfig = Pick<
  Config,
  | "aiProvider"
  | "anthropicApiKey"
  | "anthropicBaseUrl"
  | "anthropicModel"
  | "openaiBaseUrl"
  | "openaiApiKey"
  | "openaiModel"
  | "ollamaBaseUrl"
  | "ollamaModel"
>;

/** 从现有服务端配置创建提供方；不会读取或修改浏览器端状态 */
export function createAIProvider(config: AIProviderConfig, dependencies: AIProviderDependencies = {}): AIProvider {
  switch (config.aiProvider) {
    case "anthropic":
      return new AnthropicAIProvider({
        apiKey: config.anthropicApiKey,
        baseURL: config.anthropicBaseUrl,
        model: config.anthropicModel || "claude-opus-5",
        timeoutMs: dependencies.timeoutMs,
        client: dependencies.anthropicClient,
      });
    case "openai":
      return new OpenAICompatibleProvider({
        baseURL: config.openaiBaseUrl,
        apiKey: config.openaiApiKey,
        model: config.openaiModel,
        timeoutMs: dependencies.timeoutMs,
        maxResponseBytes: dependencies.maxResponseBytes,
        fetchFn: dependencies.fetchFn,
      });
    case "ollama":
      return new OllamaAIProvider({
        baseURL: config.ollamaBaseUrl,
        model: config.ollamaModel,
        timeoutMs: dependencies.timeoutMs,
        maxResponseBytes: dependencies.maxResponseBytes,
        fetchFn: dependencies.fetchFn,
      });
    case "none":
    default:
      return new NoneAIProvider();
  }
}

export const getAIProvider = createAIProvider;

export * from "./provider";
export * from "./anthropic";
export * from "./openai";
export * from "./ollama";
export * from "./none";
export * from "./json";
export * from "./extractive";
export * from "./prompts";
export * from "./reporting";
