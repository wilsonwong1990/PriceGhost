type AutoTier = 'efficiency' | 'balance' | 'intelligence';
type FusionTier = 'standard' | 'high' | 'max';

function invalidTier(name: string): never {
  throw Object.assign(new Error(`Invalid Copilot ${name} tier`), { statusCode: 400 });
}

export function parseCopilotAutoTier(value: unknown): AutoTier | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'efficiency' || value === 'balance' || value === 'intelligence') return value;
  return invalidTier('Auto');
}

export function parseCopilotFusionTier(value: unknown): FusionTier | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'standard' || value === 'high' || value === 'max') return value;
  return invalidTier('Fusion');
}
