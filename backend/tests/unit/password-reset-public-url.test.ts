import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const users = { findByEmail: vi.fn() };
const settings = { getSetting: vi.fn() };
const mailer = { isSystemMailerConfigured: vi.fn(), sendSystemEmail: vi.fn() };
const tokens = { create: vi.fn() };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

vi.mock('../../src/models', () => ({ userRepository: users }));
vi.mock('../../src/services/domain/system', () => ({ systemService: settings }));
vi.mock('../../src/utils/system/mailer', () => mailer);
vi.mock('../../src/utils/system/logger', () => ({ logger: log }));
vi.mock('../../src/services/domain/auth/repositories/password-reset.repository', () => ({
  passwordResetRepository: tokens,
}));

describe('password reset public URL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.getSetting.mockResolvedValue('true');
    mailer.isSystemMailerConfigured.mockReturnValue(true);
    mailer.sendSystemEmail.mockResolvedValue({ success: true });
    users.findByEmail.mockResolvedValue({
      id: 1, email: 'user@example.test', password_hash: 'hash', disabled: false,
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('uses the configured base URL for reset links', async () => {
    vi.stubEnv('PUBLIC_URL', 'https://shop.example.test/');
    const { passwordResetService } = await import('../../src/services/domain/auth/password-reset');

    await passwordResetService.requestReset('user@example.test', '192.0.2.1');

    expect(tokens.create).toHaveBeenCalledOnce();
    expect(mailer.sendSystemEmail).toHaveBeenCalledWith(
      'user@example.test',
      'PriceStalker password reset',
      expect.stringMatching(/https:\/\/shop\.example\.test\/reset-password\?token=[a-f0-9]{64}/),
    );
  });

  it('allows an HTTP origin on the local network', async () => {
    vi.stubEnv('PUBLIC_URL', 'http://192.168.1.50:3000');
    const { passwordResetService } = await import('../../src/services/domain/auth/password-reset');

    expect(await passwordResetService.isEnabled()).toBe(true);
  });

  it.each(['', 'not a URL', 'file:///etc/passwd', 'https://user:pass@example.test', 'https://example.test/base', 'https://example.test/?next=evil', 'https://example.test/#fragment', 'https://example.test/?', 'https://example.test/#'])(
    'disables reset without a valid trusted URL: %s',
    async (url) => {
      vi.stubEnv('PUBLIC_URL', url);
      const { passwordResetService } = await import('../../src/services/domain/auth/password-reset');

      expect(await passwordResetService.isEnabled()).toBe(false);
      await expect(passwordResetService.requestReset('user@example.test', '192.0.2.2')).rejects.toThrow('not available');
      expect(tokens.create).not.toHaveBeenCalled();
      expect(mailer.sendSystemEmail).not.toHaveBeenCalled();
    },
  );
});
