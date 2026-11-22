import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { systemSettingsRepository } from '../../src/models';
import { logger } from '../../src/utils/system/logger';
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
    clients: [] as Array<{ stop: () => Promise<Error[]>; forceStop: () => Promise<void>; deleteSession: (id: string) => Promise<void> }>,
    createSessionOptions: [] as unknown[],
    sessionCalls: [] as string[],
    sendAndWait: undefined as unknown as (options: { prompt: string }, timeoutMs: number) => Promise<unknown>,
    models: [] as unknown[],
    startError: undefined as Error | undefined,
    startGate: undefined as Promise<void> | undefined,
    sessionGate: undefined as Promise<void> | undefined,
    modelsGate: undefined as Promise<void> | undefined,
    stopGate: undefined as Promise<void> | undefined,
    disconnectGate: undefined as Promise<void> | undefined,
    disconnectError: undefined as Error | undefined,
  };
  return state;
});

vi.mock('@microsoft/copilot-sdk', () => {
  class FakeClient {
    options: unknown;
    stop = vi.fn(async () => {
      await sdk.stopGate;
      return [];
    });
    forceStop = vi.fn(async () => undefined);
    deleteSession = vi.fn(async (id: string) => {
      sdk.sessionCalls.push(`delete:${id}`);
    });
    constructor(options: unknown) {
      this.options = options;
      sdk.clients.push(this);
    }
    async start() {
      if (sdk.startError) throw sdk.startError;
      await sdk.startGate;
    }
    async createSession(options: unknown) {
      sdk.createSessionOptions.push(options);
      const sessionId = `session-${sdk.createSessionOptions.length}`;
      await sdk.sessionGate;
      let listener: UsageListener | undefined;
      return {
        sessionId,
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
          if (sdk.disconnectError) throw sdk.disconnectError;
          await sdk.disconnectGate;
        }),
      };
    }
    async listModels() {
      await sdk.modelsGate;
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
    sdk.startGate = undefined;
    sdk.sessionGate = undefined;
    sdk.modelsGate = undefined;
    sdk.stopGate = undefined;
    sdk.disconnectGate = undefined;
    sdk.disconnectError = undefined;
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
      expect(() => validateCopilotToken(null)).toThrow(expect.objectContaining({ statusCode: 400 }));
    });

    it('rejects a classic personal access token with the permission to use instead', async () => {
      const { validateCopilotToken } = await load();
      expect(() => validateCopilotToken('ghp_classic')).toThrow(/Copilot Requests/);
      expect(() => validateCopilotToken('ghp_classic')).toThrow(expect.objectContaining({ statusCode: 400 }));
    });
  });

  describe('runCopilotPrompt', () => {
    it.each([
      ['auto', 'efficiency', null, { autoTier: 'efficiency' }],
      ['auto', 'balance', 'max', { autoTier: 'balance' }],
      ['auto', 'intelligence', null, { autoTier: 'intelligence' }],
      ['auto', null, null, { autoTier: undefined }],
      ['fusion', 'intelligence', 'standard', { fusionTier: 'standard' }],
      ['fusion', null, 'high', { fusionTier: 'high' }],
      ['fusion', null, 'max', { fusionTier: 'max' }],
      ['fusion', null, null, { fusionTier: 'standard' }],
      ['gpt-5', 'balance', 'max', undefined],
    ])('passes the active routing tier for %s', async (model, autoTier, fusionTier, capi) => {
      const { runCopilotPrompt } = await load();
      await runCopilotPrompt({ token: TOKEN, model, autoTier, fusionTier, prompt: 'hi', timeoutMs: 5000 });
      expect(sdk.createSessionOptions[0]).toMatchObject({
        model, github: capi ? { token: TOKEN, capi } : { token: TOKEN },
      });
      if (!capi) expect(sdk.createSessionOptions[0]).not.toHaveProperty('github.capi');
    });

    it('rejects invalid active tiers before starting the runtime', async () => {
      const { runCopilotPrompt } = await load();
      await expect(runCopilotPrompt({ token: TOKEN, model: 'auto', autoTier: 'not-a-tier', prompt: 'hi', timeoutMs: 5000 }))
        .rejects.toMatchObject({ statusCode: 400, message: 'Invalid Copilot Auto tier' });
      await expect(runCopilotPrompt({ token: TOKEN, model: 'fusion', fusionTier: { invalid: true }, prompt: 'hi', timeoutMs: 5000 }))
        .rejects.toMatchObject({ statusCode: 400, message: 'Invalid Copilot Fusion tier' });
      expect(sdk.clients).toHaveLength(0);
    });

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

      await vi.waitFor(() => expect(sdk.sessionCalls).toEqual(['send:hi', 'disconnect', 'delete:session-1']));
    });

    it('returns a successful reply without waiting for stalled cleanup', async () => {
      vi.useFakeTimers();
      sdk.disconnectGate = new Promise(() => {});
      const { runCopilotPrompt } = await load();
      const result = await runCopilotPrompt({ token: TOKEN, prompt: 'hi', timeoutMs: 100 });
      expect(result.text).toBe('{"price": 12.34}');
      expect(sdk.sessionCalls).not.toContain('delete:session-1');
      await vi.advanceTimersByTimeAsync(5001);
      expect(sdk.sessionCalls).toContain('delete:session-1');
    });

    it('does not log secrets from SDK cleanup errors', async () => {
      sdk.disconnectError = new Error(`SDK failed with ${TOKEN}`);
      const { runCopilotPrompt } = await load();
      await runCopilotPrompt({ token: TOKEN, prompt: 'hi', timeoutMs: 5000 });
      await vi.waitFor(() => expect(logger.debug).toHaveBeenCalledWith('AI | copilot | Could not disconnect the session', 'AI'));
      expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain(TOKEN);
    });

    it('aborts and still deletes the session when the request fails', async () => {
      sdk.sendAndWait = async () => {
        throw new Error('Timeout after 5000ms waiting for session.idle');
      };
      const { runCopilotPrompt } = await load();

      await expect(runCopilotPrompt({ token: TOKEN, prompt: 'hi', timeoutMs: 5000 })).rejects.toThrow(/timeout/i);
      await vi.waitFor(() => expect(sdk.sessionCalls).toEqual(['send:hi', 'abort', 'disconnect', 'delete:session-1']));
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
      await expect(runCopilotPrompt({ token: TOKEN, prompt: 'a', timeoutMs: 5000 })).rejects.toMatchObject({
        message: 'GitHub Copilot request failed',
        cause: expect.objectContaining({ message: 'Upstream connection refused by the model host' }),
      });
      await expect(runCopilotPrompt({ token: TOKEN, prompt: 'b', timeoutMs: 5000 })).rejects.toThrow(/request failed/);
      expect(sdk.clients).toHaveLength(1);

      sdk.sendAndWait = async () => {
        throw new Error('CLI server exited unexpectedly with code 1');
      };
      await expect(runCopilotPrompt({ token: TOKEN, prompt: 'c', timeoutMs: 5000 })).rejects.toThrow(/request failed/);
      sdk.sendAndWait = async () => ({ data: { content: 'back' } });
      await runCopilotPrompt({ token: TOKEN, prompt: 'd', timeoutMs: 5000 });
      expect(sdk.clients).toHaveLength(2);
      await vi.waitFor(() => expect(sdk.clients[0].stop).toHaveBeenCalled());
    });

    it.each([
      ['DISABLE_TELEMETRY', 'true', 'false'],
      ['DO_NOT_TRACK', '1', ''],
      ['TELEMETRY_ENABLED', 'false', 'false'],
    ])('forces the runtime telemetry opt-out for %s', async (name, value, runtimeValue) => {
      const original = { ...process.env };
      process.env.COPILOT_TELEMETRY_DISABLED = runtimeValue;
      process.env[name] = value;
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
      await expect(runCopilotPrompt({ token: TOKEN, prompt: 'hi', timeoutMs: 5000 })).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it('does not expose unexpected SDK errors as client validation errors', async () => {
      sdk.startError = Object.assign(new Error('Domain is required: internal SDK details'), { statusCode: 403 });
      const { runCopilotPrompt } = await load();
      await expect(runCopilotPrompt({ token: TOKEN, prompt: 'hi', timeoutMs: 5000 })).rejects.toMatchObject({
        message: 'GitHub Copilot request failed',
        status: 403,
        cause: sdk.startError,
      });
    });

    it('times out startup and replaces the runtime without waiting for startup to settle', async () => {
      sdk.startGate = new Promise(() => {});
      const { runCopilotPrompt } = await load();
      await expect(runCopilotPrompt({ token: TOKEN, prompt: 'hi', timeoutMs: 50 })).rejects.toThrow(/timeout/);
      expect(sdk.clients[0].stop).toHaveBeenCalled();

      sdk.startGate = undefined;
      await expect(runCopilotPrompt({ token: TOKEN, prompt: 'next', timeoutMs: 5000 })).resolves.toMatchObject({
        text: '{"price": 12.34}',
      });
      expect(sdk.clients).toHaveLength(2);
    });

    it('cleans up a session created after the request deadline without sending the prompt', async () => {
      let release!: () => void;
      sdk.sessionGate = new Promise(resolve => { release = resolve; });
      const { runCopilotPrompt } = await load();
      await expect(runCopilotPrompt({ token: TOKEN, prompt: 'late', timeoutMs: 50 })).rejects.toThrow(/timeout/);
      release();
      await vi.waitFor(() => expect(sdk.sessionCalls).toContain('delete:session-1'));
      expect(sdk.sessionCalls).toContain('abort');
      expect(sdk.sessionCalls).not.toContain('send:late');
    });

    it('retires a runtime even if session creation never settles', async () => {
      vi.useFakeTimers();
      sdk.sessionGate = new Promise(() => {});
      const { runCopilotPrompt } = await load();
      const request = runCopilotPrompt({ token: TOKEN, prompt: 'hi', timeoutMs: 100 });
      const result = expect(request).rejects.toThrow(/timeout/);
      await vi.advanceTimersByTimeAsync(101);
      await result;
      expect(sdk.clients[0].stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5001);
      expect(sdk.clients[0].stop).toHaveBeenCalled();
    });

    it('cleans up a late session without interrupting an unrelated active request', async () => {
      let releaseSession!: () => void;
      let releaseOther!: () => void;
      sdk.sessionGate = new Promise(resolve => { releaseSession = resolve; });
      sdk.sendAndWait = () => new Promise(resolve => {
        releaseOther = () => resolve({ data: { content: 'done' } });
      });
      const { runCopilotPrompt } = await load();
      const first = runCopilotPrompt({ token: TOKEN, prompt: 'late', timeoutMs: 300 });
      const firstResult = expect(first).rejects.toThrow(/timeout/);
      await vi.waitFor(() => expect(sdk.createSessionOptions).toHaveLength(1));
      sdk.sessionGate = undefined;
      const second = runCopilotPrompt({ token: TOKEN, prompt: 'other', timeoutMs: 5000 });
      await vi.waitFor(() => expect(sdk.sessionCalls).toContain('send:other'));
      await firstResult;
      releaseOther();
      expect((await second).text).toBe('done');
      expect(sdk.clients[0].stop).not.toHaveBeenCalled();
      releaseSession();
      await vi.waitFor(() => expect(sdk.sessionCalls).toContain('abort'));
      await vi.waitFor(() => expect(sdk.sessionCalls).toContain('delete:session-1'));
      expect(sdk.sessionCalls).not.toContain('send:late');
      await vi.waitFor(() => expect(sdk.clients[0].stop).toHaveBeenCalled());
    });

    it('aborts a hung prompt while allowing another request on the same runtime to finish', async () => {
      let release!: () => void;
      sdk.sendAndWait = ({ prompt }) => prompt === 'hung'
        ? new Promise(() => {})
        : new Promise(resolve => { release = () => resolve({ data: { content: 'done' } }); });
      const { runCopilotPrompt } = await load();
      const first = runCopilotPrompt({ token: TOKEN, prompt: 'hung', timeoutMs: 200 });
      await vi.waitFor(() => expect(sdk.sessionCalls).toContain('send:hung'));
      const second = runCopilotPrompt({ token: TOKEN, prompt: 'other', timeoutMs: 5000 });
      await vi.waitFor(() => expect(sdk.sessionCalls).toContain('send:other'));
      await expect(first).rejects.toThrow(/timeout/);
      expect(sdk.sessionCalls).toContain('abort');
      expect(sdk.clients[0].stop).not.toHaveBeenCalled();
      release();
      expect((await second).text).toBe('done');
      await vi.waitFor(() => expect(sdk.clients[0].stop).toHaveBeenCalled());
    });

    it('force-stops a runtime when graceful shutdown hangs', async () => {
      vi.useFakeTimers();
      sdk.stopGate = new Promise(() => {});
      const { runCopilotPrompt } = await load();
      await runCopilotPrompt({ token: TOKEN, prompt: 'hi', timeoutMs: 5000 });
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 5001);
      expect(sdk.clients[0].forceStop).toHaveBeenCalled();
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

    it('uses a fresh discovery runtime without replacing the foreground runtime', async () => {
      const { listCopilotModels, runCopilotPrompt } = await load();
      await runCopilotPrompt({ token: TOKEN, prompt: 'first', timeoutMs: 5000 });
      sdk.models = [{ id: 'one', name: 'One' }];
      expect((await listCopilotModels(TOKEN))[0].id).toBe('one');
      sdk.models = [{ id: 'two', name: 'Two' }];
      expect((await listCopilotModels(TOKEN))[0].id).toBe('two');
      await runCopilotPrompt({ token: TOKEN, prompt: 'second', timeoutMs: 5000 });
      expect(sdk.clients).toHaveLength(3);
      expect(sdk.clients[0].stop).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(sdk.clients[1].stop).toHaveBeenCalled());
      await vi.waitFor(() => expect(sdk.clients[2].stop).toHaveBeenCalled());
    });

    it('times out model discovery and retires its runtime', async () => {
      vi.useFakeTimers();
      sdk.modelsGate = new Promise(() => {});
      const { listCopilotModels } = await load();
      const result = listCopilotModels(TOKEN);
      const expectation = expect(result).rejects.toThrow(/timeout/);
      await vi.advanceTimersByTimeAsync(10001);
      await expectation;
      expect(sdk.clients[0].stop).toHaveBeenCalled();
    });

    it('returns sanitized client errors for discovery authentication failures', async () => {
      sdk.startError = new Error('401 Bad credentials');
      const { listCopilotModels } = await load();
      await expect(listCopilotModels(TOKEN)).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('fine-grained personal access token'),
      });
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

    it('uses the saved tier from cached settings for normal generation', async () => {
      vi.resetModules();
      repo.getAll.mockResolvedValue({
        ai_provider: 'copilot', copilot_api_key: TOKEN, copilot_model: 'fusion',
        copilot_auto_tier: 'balance', copilot_fusion_tier: 'high',
      });
      const { settingsCache } = await import('../../src/utils/system/cache/SettingsCache');
      const { getAIProvider } = await import('../../src/services/ai/client');
      const settings = await settingsCache.getAISettings();
      await getAIProvider(settings).generate('price?');
      expect(sdk.createSessionOptions[0]).toMatchObject({
        model: 'fusion', github: { capi: { fusionTier: 'high' } },
      });
    });

    it('persists and reads both tier settings through the repository', async () => {
      const { systemSettingsRepository: repository } = await import('../../src/services/domain/system/repositories/system-settings.repository');
      const getAll = vi.spyOn(repository, 'getAll').mockResolvedValue({
        copilot_auto_tier: 'efficiency', copilot_fusion_tier: 'max',
      });
      const set = vi.spyOn(repository, 'set').mockResolvedValue();
      try {
        const settings = await repository.updateAISettings({ copilot_auto_tier: 'efficiency', copilot_fusion_tier: 'max' });
        expect(set).toHaveBeenCalledWith('copilot_auto_tier', 'efficiency');
        expect(set).toHaveBeenCalledWith('copilot_fusion_tier', 'max');
        expect(settings).toMatchObject({ copilot_auto_tier: 'efficiency', copilot_fusion_tier: 'max' });
      } finally {
        getAll.mockRestore();
        set.mockRestore();
      }
    });

    it('uses the selected tier in a provider verification request', async () => {
      const { testCopilotConnection } = await import('../../src/services/ai/connection-test');
      await testCopilotConnection(TOKEN, 'fusion', { fusionTier: 'max' });
      expect(sdk.createSessionOptions[0]).toMatchObject({
        model: 'fusion', github: { capi: { fusionTier: 'max' } },
      });
    });

    it('rejects invalid tier settings and accepts retained inactive tiers', async () => {
      const { AISettingsService } = await import('../../src/services/domain/system/settings/ai');
      const service = new AISettingsService();
      repo.getAISettings.mockResolvedValue(storedSettings({}));
      repo.updateAISettings.mockResolvedValue(storedSettings({}));
      await expect(service.updateAISettings({ copilot_auto_tier: 'unknown' }, 7))
        .rejects.toMatchObject({ statusCode: 400 });
      await expect(service.updateAISettings({ copilot_fusion_tier: 3 }, 7))
        .rejects.toMatchObject({ statusCode: 400 });
      expect(repo.updateAISettings).not.toHaveBeenCalled();
      await service.updateAISettings({ copilot_model: 'gpt-5', copilot_auto_tier: 'balance', copilot_fusion_tier: 'max' }, 7);
      expect(repo.updateAISettings).toHaveBeenCalledWith({
        copilot_model: 'gpt-5', copilot_auto_tier: 'balance', copilot_fusion_tier: 'max',
      });
    });

    it.each(['true', 'false'])('keeps the stored token write-only with REDACT_API_KEYS=%s', async (redact) => {
      vi.resetModules();
      const { AISettingsService } = await import('../../src/services/domain/system/settings/ai');
      const originalEnv = process.env.REDACT_API_KEYS;
      process.env.REDACT_API_KEYS = redact;
      try {
        repo.getAISettings.mockResolvedValue(storedSettings({ copilot_api_key: TOKEN }));
        repo.updateAISettings.mockResolvedValue(storedSettings({}));
        const service = new AISettingsService();

        const settings = await service.getAISettings();
        expect(settings.copilot_api_key).toBe('********');

        await service.updateAISettings({ copilot_api_key: settings.copilot_api_key, copilot_model: 'gpt-5' }, 7);
        expect(repo.updateAISettings).toHaveBeenCalledWith({ copilot_model: 'gpt-5' });
        await service.updateAISettings({ copilot_api_key: '' }, 7);
        expect(repo.updateAISettings).toHaveBeenLastCalledWith({ copilot_api_key: '' });
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

      const result = await new AISettingsService().refreshProviderModels('copilot', { apiKey: '********' });

      expect(result.models).toEqual([{ id: 'gpt-5', name: 'GPT-5', description: undefined }]);
      expect(sdk.clients).toHaveLength(1);
    });

    it('rejects modified Copilot placeholders instead of silently retaining the stored token', async () => {
      const { AISettingsService } = await import('../../src/services/domain/system/settings/ai');
      repo.getAISettings.mockResolvedValue(storedSettings({ copilot_api_key: TOKEN }));
      const service = new AISettingsService();
      await expect(service.updateAISettings({ copilot_api_key: '********replacement' }, 7)).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(repo.updateAISettings).not.toHaveBeenCalled();
      await expect(service.refreshProviderModels('copilot', { apiKey: '********replacement' })).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(sdk.clients).toHaveLength(0);
    });

    it('omits API keys from both general settings responses while leaving repository reads intact', async () => {
      const { SystemSettingsService } = await import('../../src/services/domain/system/settings/system');
      const raw = { copilot_api_key: TOKEN, openai_api_key: 'secret', ai_provider: 'copilot', browser_timeout: '1000' };
      repo.getAll.mockResolvedValue(raw);
      repo.set.mockResolvedValue(undefined);
      const service = new SystemSettingsService();
      expect(await service.getSettings()).toEqual({ ai_provider: 'copilot', browser_timeout: '1000' });
      expect(await service.updateSettings({ browser_timeout: 1000 }, 7)).toEqual({
        ai_provider: 'copilot', browser_timeout: '1000',
      });
      expect(await repo.getAll()).toEqual(raw);
    });
  });
});
