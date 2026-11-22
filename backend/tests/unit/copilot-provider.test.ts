import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { systemSettingsRepository } from '../../src/models';
import type { AISettings } from '../../src/models/types';

/**
 * The GitHub Copilot provider.
 *
 * The SDK is replaced with a fake so these tests pin what this application
 * asks of it: a minimal runtime environment, throwaway sessions with every tool
 * and permission refused, a session that is deleted whatever the outcome, and
 * a token that is validated, masked and surfaced like every other provider key.
 */

vi.mock('../../src/models', () => ({
  systemSettingsRepository: {
    getAISettings: vi.fn(),
    updateAISettings: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    getAll: vi.fn(),
  },
}));

vi.mock('../../src/utils/system/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type UsageListener = (event: { type: string; data: Record<string, number | undefined> }) => void;

const sdk = vi.hoisted(() => {
  const state = {
    stateDirs: [] as string[],
    forSpawnedStdio: vi.fn((options: unknown) => options),
    clients: [] as Array<{ stop: () => Promise<void>; deleteSession: (id: string) => Promise<void> }>,
    createSessionOptions: [] as unknown[],
    sessionCalls: [] as string[],
    sendAndWait: undefined as unknown as (options: { prompt: string }, timeoutMs: number) => Promise<unknown>,
    models: [] as unknown[],
    startError: undefined as Error | undefined,
  };
  return state;
});

vi.mock('@microsoft/copilot-sdk', () => {
  class FakeClient {
    options: unknown;
    stop = vi.fn(async () => undefined);
    deleteSession = vi.fn(async (id: string) => {
      sdk.sessionCalls.push(`delete:${id}`);
    });
    constructor(options: unknown) {
      this.options = options;
      sdk.clients.push(this);
    }
    async start() {
      if (sdk.startError) throw sdk.startError;
    }
    async createSession(options: unknown) {
      sdk.createSessionOptions.push(options);
      let listener: UsageListener | undefined;
      return {
        sessionId: `session-${sdk.createSessionOptions.length}`,
        on: (handler: UsageListener) => {
          listener = handler;
          return () => undefined;
        },
        sendAndWait: async (request: { prompt: string }, timeoutMs: number) => {
          sdk.sessionCalls.push(`send:${request.prompt}`);
          listener?.({ type: 'assistant.usage', data: { inputTokens: 11, outputTokens: 4 } });
          return sdk.sendAndWait(request, timeoutMs);
        },
        abort: vi.fn(async () => {
          sdk.sessionCalls.push('abort');
        }),
        disconnect: vi.fn(async () => {
          sdk.sessionCalls.push('disconnect');
        }),
      };
    }
    async listModels() {
      return sdk.models;
    }
  }
  return {
    CopilotClient: FakeClient,
    RuntimeConnection: { forSpawnedStdio: (options: unknown) => sdk.forSpawnedStdio(options) },
  };
});

const repo = vi.mocked(systemSettingsRepository);

function storedSettings(fields: Partial<AISettings>): AISettings {
  return fields as AISettings;
}

const TOKEN = 'github_pat_exampletoken1234567890';

async function load() {
  vi.resetModules();
  return import('../../src/services/ai/providers/copilot-client');
}

describe('GitHub Copilot provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Each reloaded module registers its own exit hook.
    process.setMaxListeners(50);
    sdk.clients.length = 0;
    sdk.createSessionOptions.length = 0;
    sdk.sessionCalls.length = 0;
    sdk.models = [];
    sdk.startError = undefined;
    sdk.sendAndWait = async () => ({ data: { content: '{"price": 12.34}' } });
  });

  afterEach(() => {
    vi.useRealTimers();
    // The runtime would remove these on process exit, which a test worker does not reach.
    for (const [options] of sdk.forSpawnedStdio.mock.calls as unknown as Array<[{ baseDirectory: string }]>) {
      fs.rmSync(options.baseDirectory, { recursive: true, force: true });
    }
  });

  describe('validateCopilotToken', () => {
    it('trims the token and rejects an empty one', async () => {
      const { validateCopilotToken } = await load();
      expect(validateCopilotToken(`  ${TOKEN}  `)).toBe(TOKEN);
      expect(() => validateCopilotToken('   ')).toThrow(/token is required/);
      expect(() => validateCopilotToken(null)).toThrow(/token is required/);
    });

    it('rejects a classic personal access token with the permission to use instead', async () => {
      const { validateCopilotToken } = await load();
      expect(() => validateCopilotToken('ghp_classic')).toThrow(/Copilot Requests/);
    });
  });

  describe('runCopilotPrompt', () => {
    it('returns the reply text and the summed token usage', async () => {
      const { runCopilotPrompt } = await load();
      const response = await runCopilotPrompt({ token: TOKEN, prompt: 'price?', timeoutMs: 5000 });

      expect(response.text).toBe('{"price": 12.34}');
      expect(response.usage).toEqual({ promptTokens: 11, completionTokens: 4, totalTokens: 15 });
    });

    it('starts the runtime with only the allowlisted environment', async () => {
      const original = { ...process.env };
      delete process.env.DISABLE_TELEMETRY;
      process.env.DATABASE_URL = 'postgres://secret';
      process.env.JWT_SECRET = 'secret';
      process.env.HTTPS_PROXY = 'http://proxy.example.test:3128';
      try {
        const { runCopilotPrompt } = await load();
        await runCopilotPrompt({ token: TOKEN, prompt: 'hi', timeoutMs: 5000 });

        const [{ env, baseDirectory, workingDirectory }] = sdk.forSpawnedStdio.mock.calls[0] as unknown as [
          { env: Record<string, string>; baseDirectory: string; workingDirectory: string },
        ];
        expect(workingDirectory).toBe(baseDirectory);
        expect(env.HTTPS_PROXY).toBe('http://proxy.example.test:3128');
        expect(env).not.toHaveProperty('DATABASE_URL');
        expect(env).not.toHaveProperty('JWT_SECRET');
      } finally {
        process.env = original;
      }
    });

    it('creates a session with no tools, no persistence and every permission refused', async () => {
      const { runCopilotPrompt } = await load();
      await runCopilotPrompt({ token: TOKEN, model: 'gpt-5', prompt: 'hi', timeoutMs: 5000 });

      const [options] = sdk.createSessionOptions as Array<{
        model: string;
        tools: { availableTools: string[] };
        state: { infiniteSessions: { enabled: boolean }; memory: { enabled: boolean } };
        permissions: { onRequest: () => { kind: string } };
        systemMessage: { mode: string; content: string };
      }>;
      expect(options.model).toBe('gpt-5');
      expect(options.tools.availableTools).toEqual([]);
      expect(options.state.infiniteSessions.enabled).toBe(false);
      expect(options.state.memory.enabled).toBe(false);
      expect(options.permissions.onRequest().kind).toBe('reject');
      expect(options.systemMessage.mode).toBe('replace');
    });

    it('falls back to the auto model and only asks for JSON when told to', async () => {
      const { runCopilotPrompt } = await load();
      await runCopilotPrompt({ token: TOKEN, prompt: 'a', timeoutMs: 5000 });
      await runCopilotPrompt({ token: TOKEN, prompt: 'b', timeoutMs: 5000, jsonMode: true });

      const [plain, json] = sdk.createSessionOptions as Array<{ model: string; systemMessage: { content: string } }>;
      expect(plain.model).toBe('auto');
      expect(plain.systemMessage.content).not.toMatch(/valid JSON/);
      expect(json.systemMessage.content).toMatch(/valid JSON/);
    });

    it('deletes the session after a successful request', async () => {
      const { runCopilotPrompt } = await load();
      await runCopilotPrompt({ token: TOKEN, prompt: 'hi', timeoutMs: 5000 });

      expect(sdk.sessionCalls).toEqual(['send:hi', 'disconnect', 'delete:session-1']);
    });

    it('aborts and still deletes the session when the request fails', async () => {
      sdk.sendAndWait = async () => {
        throw new Error('Timeout after 5000ms waiting for session.idle');
      };
      const { runCopilotPrompt } = await load();

      await expect(runCopilotPrompt({ token: TOKEN, prompt: 'hi', timeoutMs: 5000 })).rejects.toThrow(/Timeout/);
      expect(sdk.sessionCalls).toEqual(['send:hi', 'abort', 'disconnect', 'delete:session-1']);
    });

    it('reuses one runtime for the same token and starts another when the token changes', async () => {
      const { runCopilotPrompt } = await load();
      await runCopilotPrompt({ token: TOKEN, prompt: 'a', timeoutMs: 5000 });
      await runCopilotPrompt({ token: TOKEN, prompt: 'b', timeoutMs: 5000 });
      expect(sdk.clients).toHaveLength(1);

      await runCopilotPrompt({ token: `${TOKEN}-rotated`, prompt: 'c', timeoutMs: 5000 });
      expect(sdk.clients).toHaveLength(2);
      await vi.waitFor(() => expect(sdk.clients[0].stop).toHaveBeenCalled());
    });

    it('lets a request on the old token finish before its runtime is stopped', async () => {
      let release!: () => void;
      sdk.sendAndWait = () =>
        new Promise((resolve) => {
          release = () => resolve({ data: { content: 'done' } });
        });
      const { runCopilotPrompt } = await load();
      const first = runCopilotPrompt({ token: TOKEN, prompt: 'a', timeoutMs: 5000 });
      await vi.waitFor(() => expect(sdk.sessionCalls).toContain('send:a'));

      sdk.sendAndWait = async () => ({ data: { content: 'other' } });
      await runCopilotPrompt({ token: `${TOKEN}-rotated`, prompt: 'b', timeoutMs: 5000 });
      expect(sdk.clients).toHaveLength(2);
      expect(sdk.clients[0].stop).not.toHaveBeenCalled();

      release();
      expect((await first).text).toBe('done');
      await vi.waitFor(() => expect(sdk.clients[0].stop).toHaveBeenCalled());
    });

    it('replaces the runtime after the SDK reports it has exited, but not after an unrelated error', async () => {
      const { runCopilotPrompt } = await load();

      sdk.sendAndWait = async () => {
        throw new Error('Upstream connection refused by the model host');
      };
      await expect(runCopilotPrompt({ token: TOKEN, prompt: 'a', timeoutMs: 5000 })).rejects.toThrow(/refused/);
      await expect(runCopilotPrompt({ token: TOKEN, prompt: 'b', timeoutMs: 5000 })).rejects.toThrow(/refused/);
      expect(sdk.clients).toHaveLength(1);

      sdk.sendAndWait = async () => {
        throw new Error('CLI server exited unexpectedly with code 1');
      };
      await expect(runCopilotPrompt({ token: TOKEN, prompt: 'c', timeoutMs: 5000 })).rejects.toThrow(/exited/);
      sdk.sendAndWait = async () => ({ data: { content: 'back' } });
      await runCopilotPrompt({ token: TOKEN, prompt: 'd', timeoutMs: 5000 });
      expect(sdk.clients).toHaveLength(2);
      await vi.waitFor(() => expect(sdk.clients[0].stop).toHaveBeenCalled());
    });

    it('opts the runtime out of telemetry when the application is opted out', async () => {
      const original = { ...process.env };
      delete process.env.COPILOT_TELEMETRY_DISABLED;
      process.env.DISABLE_TELEMETRY = 'true';
      try {
        const { runCopilotPrompt } = await load();
        await runCopilotPrompt({ token: TOKEN, prompt: 'hi', timeoutMs: 5000 });

        const [{ env }] = sdk.forSpawnedStdio.mock.calls[0] as unknown as [{ env: Record<string, string> }];
        expect(env.COPILOT_TELEMETRY_DISABLED).toBe('true');
      } finally {
        process.env = original;
      }
    });

    it('stops the runtime and removes its state directory once it has been idle', async () => {
      vi.useFakeTimers();
      const { runCopilotPrompt } = await load();
      await runCopilotPrompt({ token: TOKEN, prompt: 'hi', timeoutMs: 5000 });

      const [{ baseDirectory }] = sdk.forSpawnedStdio.mock.calls[0] as unknown as [{ baseDirectory: string }];
      expect(fs.existsSync(baseDirectory)).toBe(true);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      vi.useRealTimers();
      await vi.waitFor(() => expect(fs.existsSync(baseDirectory)).toBe(false));
      expect(sdk.clients[0].stop).toHaveBeenCalled();
    });

    it('turns a rejected token into guidance the admin can act on', async () => {
      sdk.startError = new Error('Request session.create failed: 401 Unauthorized: {"message":"Bad credentials"}');
      const { runCopilotPrompt } = await load();

      await expect(runCopilotPrompt({ token: TOKEN, prompt: 'hi', timeoutMs: 5000 })).rejects.toThrow(
        /fine-grained personal access token/
      );
    });
  });

  describe('listCopilotModels', () => {
    it('lists enabled models by name with their vendor and premium request cost', async () => {
      sdk.models = [
        { id: 'z-model', name: 'Zeta', vendor: 'Acme', billing: { multiplier: 2 } },
        { id: 'a-model', name: 'Alpha', vendor: 'Acme', policy: { state: 'enabled' } },
        { id: 'blocked', name: 'Blocked', policy: { state: 'disabled' } },
      ];
      const { listCopilotModels } = await load();

      expect(await listCopilotModels(TOKEN)).toEqual([
        { id: 'a-model', name: 'Alpha', description: 'Acme' },
        { id: 'z-model', name: 'Zeta', description: 'Acme, 2x premium requests' },
      ]);
    });
  });

  describe('provider wiring', () => {
    it('is selected by the factory and sends the stored token and model', async () => {
      vi.resetModules();
      const { getAIProvider } = await import('../../src/services/ai/client');
      const provider = getAIProvider(
        storedSettings({ ai_provider: 'copilot', copilot_api_key: TOKEN, copilot_model: 'gpt-5', ai_timeout: 9000 })
      );

      const response = await provider.generate('what is the price?');

      expect(response.text).toBe('{"price": 12.34}');
      expect(sdk.createSessionOptions).toHaveLength(1);
      expect(sdk.sessionCalls[0]).toBe('send:what is the price?');
    });

    it('masks the stored token and drops a masked token echoed back on save', async () => {
      vi.resetModules();
      const { AISettingsService } = await import('../../src/services/domain/system/settings/ai');
      const originalEnv = process.env.REDACT_API_KEYS;
      process.env.REDACT_API_KEYS = 'true';
      try {
        repo.getAISettings.mockResolvedValue(storedSettings({ copilot_api_key: TOKEN }));
        repo.updateAISettings.mockResolvedValue(storedSettings({}));
        const service = new AISettingsService();

        const settings = await service.getAISettings();
        expect(settings.copilot_api_key).not.toBe(TOKEN);
        expect(settings.copilot_api_key).toContain('...');

        await service.updateAISettings({ copilot_api_key: settings.copilot_api_key, copilot_model: 'gpt-5' }, 7);
        expect(repo.updateAISettings).toHaveBeenCalledWith({ copilot_model: 'gpt-5' });
      } finally {
        process.env.REDACT_API_KEYS = originalEnv;
      }
    });

    it('refreshes the model list with the stored token behind a masked one', async () => {
      vi.resetModules();
      const { AISettingsService } = await import('../../src/services/domain/system/settings/ai');
      sdk.models = [{ id: 'gpt-5', name: 'GPT-5' }];
      repo.getAISettings.mockResolvedValue(storedSettings({ copilot_api_key: TOKEN }));
      repo.set.mockResolvedValue(undefined as never);

      const result = await new AISettingsService().refreshProviderModels('copilot', { apiKey: 'gith...7890' });

      expect(result.models).toEqual([{ id: 'gpt-5', name: 'GPT-5', description: undefined }]);
      expect(sdk.clients).toHaveLength(1);
    });
  });
});
