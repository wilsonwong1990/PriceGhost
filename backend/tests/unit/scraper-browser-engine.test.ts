import { describe, it, expect } from 'vitest';
import {
  buildFirefoxPrefs,
  firefoxProxyPrefs,
  resolveBrowserEngine,
  shouldApplyUserAgentToFirefox,
} from '../../../scraper/src/core/engine';

/**
 * The per-retailer Firefox engine.
 *
 * Firefox cannot take the identity overrides Chromium gets per page over CDP,
 * so its proxy and User-Agent are fixed with preferences at launch. These pin
 * how a request's engine, proxy URL and User-Agent turn into those
 * preferences, without launching a browser.
 */

const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

describe('resolveBrowserEngine', () => {
  it('defaults to Chromium when a request names no engine', () => {
    expect(resolveBrowserEngine(undefined)).toBe('chromium');
    expect(resolveBrowserEngine(null)).toBe('chromium');
  });

  it('accepts the engines the scraper has', () => {
    expect(resolveBrowserEngine('chromium')).toBe('chromium');
    expect(resolveBrowserEngine('firefox')).toBe('firefox');
  });

  it('rejects anything else rather than quietly serving Chromium', () => {
    expect(resolveBrowserEngine('webkit')).toBeNull();
    expect(resolveBrowserEngine('Firefox')).toBeNull();
    expect(resolveBrowserEngine('')).toBeNull();
    expect(resolveBrowserEngine(1)).toBeNull();
  });
});

describe('shouldApplyUserAgentToFirefox', () => {
  it('applies only a Firefox User-Agent', () => {
    expect(shouldApplyUserAgentToFirefox(FIREFOX_UA)).toBe(true);
    // A Chrome UA from Gecko contradicts every other signal the page can read.
    expect(shouldApplyUserAgentToFirefox(CHROME_UA)).toBe(false);
    expect(shouldApplyUserAgentToFirefox(null)).toBe(false);
    expect(shouldApplyUserAgentToFirefox('')).toBe(false);
  });
});

describe('firefoxProxyPrefs', () => {
  it('routes both HTTP and HTTPS through an http:// proxy', () => {
    expect(firefoxProxyPrefs('http://192.0.2.10:8888')).toEqual({
      'network.proxy.type': 1,
      'network.proxy.http': '192.0.2.10',
      'network.proxy.http_port': 8888,
      'network.proxy.ssl': '192.0.2.10',
      'network.proxy.ssl_port': 8888,
      'network.proxy.no_proxies_on': '',
    });
  });

  it('uses the scheme default port when the URL has none', () => {
    expect(firefoxProxyPrefs('http://proxy.example.test')['network.proxy.http_port']).toBe(80);
    expect(firefoxProxyPrefs('socks5://proxy.example.test')['network.proxy.socks_port']).toBe(1080);
  });

  it('resolves DNS through a SOCKS5 proxy but not a SOCKS4 one', () => {
    expect(firefoxProxyPrefs('socks5://proxy.example.test:1081')).toMatchObject({
      'network.proxy.socks': 'proxy.example.test',
      'network.proxy.socks_port': 1081,
      'network.proxy.socks_version': 5,
      'network.proxy.socks_remote_dns': true,
    });
    expect(firefoxProxyPrefs('socks4://proxy.example.test:1081')).toMatchObject({
      'network.proxy.socks_version': 4,
      'network.proxy.socks_remote_dns': false,
    });
  });

  it('strips the brackets from an IPv6 proxy host', () => {
    expect(firefoxProxyPrefs('http://[2001:db8::1]:3128')['network.proxy.http']).toBe('2001:db8::1');
  });

  it('does not apply credentials, matching the Chromium path', () => {
    const prefs = firefoxProxyPrefs('http://user:secret@192.0.2.10:8888');
    expect(JSON.stringify(prefs)).not.toContain('secret');
    expect(prefs['network.proxy.http']).toBe('192.0.2.10');
  });

  it('refuses a proxy it cannot express, without echoing the URL', () => {
    expect(() => firefoxProxyPrefs('https://user:secret@proxy.example.test:443')).toThrow(/https:\/\/ proxies are not supported/);
    expect(() => firefoxProxyPrefs('https://user:secret@proxy.example.test:443')).not.toThrow(/secret/);
    expect(() => firefoxProxyPrefs('not a url')).toThrow(/could not be parsed/);
  });
});

describe('buildFirefoxPrefs', () => {
  it('is empty for a direct connection with no Firefox User-Agent', () => {
    expect(buildFirefoxPrefs(null, null)).toEqual({});
    expect(buildFirefoxPrefs(null, CHROME_UA)).toEqual({});
  });

  it('combines the proxy and a Firefox User-Agent override', () => {
    expect(buildFirefoxPrefs('http://192.0.2.10:8888', FIREFOX_UA)).toMatchObject({
      'network.proxy.http': '192.0.2.10',
      'general.useragent.override': FIREFOX_UA,
    });
  });
});
