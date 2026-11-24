import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn().mockReturnValue('ok\n') }));

import { execFileSync } from 'node:child_process';
import { quoteRemoteArgument, requireProductId, runSshCommand } from '../integration/ssh-command';

describe('integration test SSH commands', () => {
  it('passes the destination and command as arguments without a local shell', () => {
    expect(runSshCommand('test-host;echo unexpected', 'true')).toBe('ok');
    expect(execFileSync).toHaveBeenCalledWith(
      'ssh', ['--', 'test-host;echo unexpected', 'true'], { encoding: 'utf-8', input: undefined },
    );
  });

  it('sends generated script contents over stdin, not through the remote shell', () => {
    runSshCommand('test-host', "cat > '/tmp/runner.js'", 'echo unsafe');
    expect(execFileSync).toHaveBeenLastCalledWith(
      'ssh', ['--', 'test-host', "cat > '/tmp/runner.js'"],
      { encoding: 'utf-8', input: 'echo unsafe' },
    );
  });

  it('quotes remote paths as one shell argument', () => {
    expect(quoteRemoteArgument("/tmp/a'b; echo unexpected")).toBe("'/tmp/a'\"'\"'b; echo unexpected'");
  });

  it.each(['1; echo unexpected', 0, -1, 1.1, null])('rejects unsafe product ID %s', (value) => {
    expect(() => requireProductId(value)).toThrow('invalid ID');
  });

  it('accepts a positive integer product ID', () => {
    expect(requireProductId(42)).toBe(42);
  });
});
