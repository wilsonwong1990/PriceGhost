import { AISettings } from '../../../models';
import { logger } from '../../../utils/system/logger';
import { withRetry } from '../../../utils/system/retry';
import { AIProvider, AIRequestOptions, AIResponse } from './types';
import { traceAiRequest, traceAiResponse } from '../trace';
import { DEFAULT_COPILOT_MODEL, runCopilotPrompt } from './copilot-client';

const PROVIDER_NAME = 'copilot';

export class CopilotProvider implements AIProvider {
  private token: string | null;
  private model: string;
  private settings: AISettings;

  constructor(settings: AISettings) {
    this.token = settings.copilot_api_key;
    this.model = settings.copilot_model || DEFAULT_COPILOT_MODEL;
    this.settings = settings;
  }

  async generate(prompt: string, options?: AIRequestOptions): Promise<AIResponse> {
    traceAiRequest(prompt, { provider: PROVIDER_NAME, productId: options?.productId, label: options?.retryLabel });

    // The Copilot runtime has no per-request output cap, so maxTokens is not applied.
    let response: AIResponse;
    try {
      response = await withRetry(() => runCopilotPrompt({
        token: this.token,
        model: this.model,
        autoTier: this.settings.copilot_auto_tier,
        fusionTier: this.settings.copilot_fusion_tier,
        prompt,
        jsonMode: options?.jsonMode,
        timeoutMs: this.settings.ai_timeout || 30000
      }), { maxRetries: this.settings.ai_max_retries ?? 2 }, options?.retryLabel || PROVIDER_NAME);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'GitHub Copilot request failed';
      logger.error(`AI | ${PROVIDER_NAME} | ${message}`, 'AI');
      throw error;
    }

    if (response.usage) {
      logger.debug(`AI | ${PROVIDER_NAME} | Tokens: ${response.usage.totalTokens}`, 'AI', {
        tokens: {
          input: response.usage.promptTokens,
          output: response.usage.completionTokens,
          total: response.usage.totalTokens
        },
        provider: PROVIDER_NAME,
        product_id: options?.productId
      });
    }

    traceAiResponse(response.text, { provider: PROVIDER_NAME, productId: options?.productId, label: options?.retryLabel });
    return response;
  }
}
