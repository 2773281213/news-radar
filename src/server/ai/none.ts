import {
  AIUnavailableError,
  type AIGenerateRequest,
  type AIGenerateResult,
  type AIProvider,
} from "./provider";

/** 显式无 AI 提供方；generate 只在本地抛出，不执行任何网络操作 */
export class NoneAIProvider implements AIProvider {
  readonly name = "none" as const;
  readonly model = "extractive";
  readonly enabled = false;

  async generate(_request: AIGenerateRequest): Promise<AIGenerateResult> {
    throw new AIUnavailableError(this.name, "AI_PROVIDER=none，使用抽取式降级");
  }
}

export const NoneProvider = NoneAIProvider;
