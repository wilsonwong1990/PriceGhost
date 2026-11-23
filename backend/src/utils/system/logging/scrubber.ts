/**
 * Scrubs inline credentials from a URL string (e.g., http://user:pass@host -> http://[REDACTED]:[REDACTED]@host)
 */
export const scrubUrlCredentials = (val: string): string => {
  if (typeof val !== 'string') return val;
  return val.replace(/(\b(?:h[\t\r\n]*t[\t\r\n]*t[\t\r\n]*p[\t\r\n]*s?[\t\r\n]*:[/\\\t\r\n]*|[a-z][a-z0-9+.\-\t\r\n]*:[\t\r\n]*\/[\t\r\n]*\/))([^/?#]+)@/gi,
    (_match, scheme: string, userinfo: string) => `${scheme}${userinfo.includes(':') ? '[REDACTED]:[REDACTED]' : '[REDACTED]'}@`);
};

/**
 * Scrubs sensitive keys and URL credentials from any data type (object, array, string, Error)
 */
export const scrubSensitiveData = (data: any): any => {
  if (!data) return data;

  if (typeof data === 'string') {
    return scrubUrlCredentials(data);
  }

  if (data instanceof Error) {
    const msg = scrubUrlCredentials(data.message);
    const stack = data.stack ? scrubUrlCredentials(data.stack) : undefined;
    const scrubbedError = new Error(msg);
    scrubbedError.name = data.name;
    if (stack) scrubbedError.stack = stack;
    return scrubbedError;
  }

  if (Array.isArray(data)) {
    return data.map(item => scrubSensitiveData(item));
  }

  if (typeof data === 'object') {
    const scrubbed: any = {};
    const sensitiveKeys = ['password', 'token', 'api_key', 'secret', 'password_hash', 'token_hash', 'authorization', 'proxy'];
    
    for (const key of Object.keys(data)) {
      const val = data[key];
      if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
        if (key.toLowerCase().includes('proxy') && typeof val === 'boolean') {
          scrubbed[key] = val;
        } else if (/^(proxy_?url)$/i.test(key) && typeof val === 'string') {
          try {
            const parsed = new URL(val);
            if (parsed.pathname && parsed.pathname !== '/' || parsed.search || parsed.hash) {
              scrubbed[key] = '[REDACTED]';
            } else {
              const credentials = parsed.username || parsed.password
                ? (parsed.password ? '[REDACTED]:[REDACTED]@' : '[REDACTED]@')
                : '';
              scrubbed[key] = `${parsed.protocol}//${credentials}${parsed.host}`;
            }
          } catch {
            scrubbed[key] = '[REDACTED]';
          }
        } else {
          scrubbed[key] = '[REDACTED]';
        }
      } else {
        scrubbed[key] = scrubSensitiveData(val);
      }
    }
    return scrubbed;
  }

  return data;
};

