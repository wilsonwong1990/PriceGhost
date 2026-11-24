import { execFileSync } from 'node:child_process';

export function quoteRemoteArgument(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

export function runSshCommand(server: string, command: string, input?: string): string {
  return execFileSync('ssh', ['--', server, command], { encoding: 'utf-8', input }).trim();
}

export function requireProductId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Product creation failed: invalid ID returned');
  }
  return value;
}
