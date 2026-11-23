import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { CDP_PROBE_TIMEOUT_MS } from '../../../scraper/src/core/health';
import { BrowserLaunchError } from '../../../scraper/src/core/engine';
import {
  closeSession,
  getBrowserSession,
  markSessionTainted,
  MAX_BROWSERS,
  MAX_PAGES_PER_BROWSER,
  MAX_SCRAPES_PER_BROWSER,
  sessions,
  sweepSessions,
  STUCK_SESSION_TIMEOUT_MS,
} from '../../../scraper/src/core/SessionManager';
import type { BrowserSession } from '../../../scraper/src/types';

/**
 * Retiring a wedged session, without losing the #208 profile cleanup
 * (issue #254).
 *
 * Two things have to hold at once here. A session wedged by an aborted scrape
 * must leave the pool immediately instead of serving the next request, and
 * tearing it down must still delete its Chromium profile directory and must
 * still not throw into the request path -- which is the machinery issue #208
 * put in place (`waitForBrowserExit`, retry-with-backoff, and the
 * `profileRemovals` WeakMap that lets `closeSession` and the `'disconnected'`
 * handler share one removal).
 *
 * `browser.close()` is the hazard: it goes over the same DevTools connection
 * that has wedged, and Puppeteer waits its 180s `protocolTimeout` for an
 * answer that never comes. So the close is capped and the process killed, and
 * the profile is removed either way.
 */

const BROWSER_CLOSE_TIMEOUT_MS = 10_000;

interface FakeBrowserOptions {
  connected?: boolean;
  /** 'hangs' is the wedged case: the close never settles. */
  close?: 'resolves' | 'rejects' | 'hangs';
  /** Whether the OS process is still running. Default: already exited. */
  alive?: boolean;
  /** Whether a CDP round trip is ever answered. Default: yes. */
  answersCdp?: boolean;
  pid?: number;
}

type PuppeteerBrowser = NonNullable<BrowserSession['browser']>;

/**
 * An EventEmitter standing in for Chromium's child process, because
 * `waitForBrowserExit` (issue #208) listens for its 'exit' event.
 */
type FakeProcess = EventEmitter & {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  pid?: number;
  kill: () => boolean;
};

function fakeProcess(options: FakeBrowserOptions): FakeProcess {
  return Object.assign(new EventEmitter(), {
    exitCode: options.alive ? null : 0,
    signalCode: null as NodeJS.Signals | null,
    pid: options.pid,
    kill: () => true,
  });
}

function fakeBrowser(options: FakeBrowserOptions = {}): { browser: PuppeteerBrowser; proc: FakeProcess } {
  const mode = options.close ?? 'resolves';
  const proc = fakeProcess(options);
  const browser = {
    connected: options.connected ?? true,
    cookies: () =>
      options.answersCdp === false
        ? new Promise<unknown>(() => {})
        : Promise.resolve([]),
    process: () => proc,
    on: () => browser,
    close: () => {
      if (mode === 'hangs') return new Promise<void>(() => {});
      if (mode === 'rejects') return Promise.reject(new Error("Network.enable timed out. Increase the 'protocolTimeout' setting"));
      return Promise.resolve();
    },
  };
  // Narrowed to the members the session lifecycle touches; see the fake in
  // scraper-session-health.test.ts for the same reasoning.
  return { browser: browser as unknown as PuppeteerBrowser, proc };
}

/** A session with a real profile directory on disk, so its removal is observable. */
async function sessionWithProfile(over: Partial<BrowserSession> = {}): Promise<BrowserSession> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pricestalker-session-'));
  await fs.mkdir(path.join(dir, 'Default'), { recursive: true });
  await fs.writeFile(path.join(dir, 'Default', 'Cookies'), 'x');

  const session: BrowserSession = {
    id: `session_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    browser: fakeBrowser().browser,
    launchPromise: null,
    activePages: 0,
    totalScrapes: 3,
    idleTimer: null,
    proxyUrl: 'http://192.168.50.200:8888',
    userAgent: null,
    browserEngine: 'chromium',
    lastActivity: Date.now(),
    userDataDir: dir,
    tainted: false,
    taintReason: null,
    ...over,
  };

  sessions.push(session);
  return session;
}

const exists = async (dir: string): Promise<boolean> => {
  try {
    await fs.stat(dir);
    return true;
  } catch {
    return false;
  }
};

beforeEach(() => {
  sessions.splice(0, sessions.length);
});

describe('concurrent browser reservations', () => {
  it('shares in-flight launches, normalizes ignored Firefox UAs, and respects both limits', async () => {
    vi.stubEnv('FIREFOX_EXECUTABLE_PATH', process.execPath);
    let finish!: (browser: PuppeteerBrowser) => void;
    const launch = new Promise<PuppeteerBrowser>(resolve => { finish = resolve; });
    const launchSpy = vi.spyOn(puppeteer, 'launch').mockImplementation(() => launch);
    const count = MAX_BROWSERS * MAX_PAGES_PER_BROWSER;
    const requests = Array.from({ length: count + 1 }, (_, index) =>
      getBrowserSession({ browserEngine: 'firefox', userAgent: `Chrome/${index}.0` }),
    );

    await vi.waitFor(() => expect(sessions.reduce((sum, session) => sum + session.activePages, 0)).toBe(count));
    expect(sessions).toHaveLength(MAX_BROWSERS);
    expect(sessions.every(session => session.activePages <= MAX_PAGES_PER_BROWSER && session.userAgent === null)).toBe(true);
    await vi.waitFor(() => expect(launchSpy).toHaveBeenCalledTimes(MAX_BROWSERS));
    finish(fakeBrowser().browser);
    const results = await Promise.all(requests);
    expect(results.filter(Boolean)).toHaveLength(count);
    expect(results.filter(result => result === null)).toHaveLength(1);
    for (const session of [...sessions]) await closeSession(session);
  });

  it('rolls back all reservations after a shared Firefox launch fails', async () => {
    vi.stubEnv('FIREFOX_EXECUTABLE_PATH', process.execPath);
    let fail!: (error: Error) => void;
    const launch = new Promise<PuppeteerBrowser>((_resolve, reject) => { fail = reject; });
    vi.spyOn(puppeteer, 'launch').mockImplementation(() => launch);
    const requests = Array.from({ length: MAX_PAGES_PER_BROWSER }, () =>
      getBrowserSession({ browserEngine: 'firefox' }),
    );
    const settled = Promise.allSettled(requests);
    await vi.waitFor(() => expect(sessions[0]?.activePages).toBe(MAX_PAGES_PER_BROWSER));
    const session = sessions[0];
    fail(new Error('launch failed for socks5://user:secret@proxy.example:1080'));
    const results = await settled;
    expect(results.every(result => result.status === 'rejected' && result.reason instanceof BrowserLaunchError)).toBe(true);
    expect(results.every(result => result.status === 'rejected' && !result.reason.message.includes('secret'))).toBe(true);
    expect(session.activePages).toBe(0);
    expect(session.totalScrapes).toBe(0);
    expect(sessions).not.toContain(session);
  });

  it('reserves the remaining scrape allowance while a launch is pending', async () => {
    let finish!: (browser: PuppeteerBrowser) => void;
    const launch = new Promise<PuppeteerBrowser>(resolve => { finish = resolve; });
    const session = await sessionWithProfile({
      browser: null,
      launchPromise: launch,
      proxyUrl: null,
      totalScrapes: MAX_SCRAPES_PER_BROWSER - 1,
    });
    for (let i = 1; i < MAX_BROWSERS; i++) {
      await sessionWithProfile({ activePages: 1 });
    }

    const first = getBrowserSession();
    await vi.waitFor(() => expect(session.totalScrapes).toBe(MAX_SCRAPES_PER_BROWSER));
    await expect(getBrowserSession()).resolves.toBeNull();
    expect(session.activePages).toBe(1);
    finish(fakeBrowser().browser);
    expect(await first).toBe(session);
    for (const pooled of [...sessions]) await closeSession(pooled);
  });

  it('does not retire a session reserved while the watchdog probe is pending', async () => {
    const browser = fakeBrowser().browser;
    vi.spyOn(browser, 'process').mockReturnValue(null);
    let failProbe!: (error: Error) => void;
    const firstProbe: ReturnType<typeof browser.cookies> = new Promise((_resolve, reject) => { failProbe = reject; });
    vi.spyOn(browser, 'cookies').mockImplementationOnce(() => firstProbe).mockResolvedValue([]);
    const session = await sessionWithProfile({ browser, proxyUrl: null });
    const sweep = sweepSessions();
    const acquired = await getBrowserSession();
    failProbe(new Error('probe failed'));
    await sweep;
    expect(acquired).toBe(session);
    expect(session.tainted).toBe(false);
    expect(sessions).toContain(session);
    await closeSession(session);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  sessions.splice(0, sessions.length);
});

describe('closeSession still removes the profile directory (issue #208)', () => {
  it('removes it on an ordinary close', async () => {
    const session = await sessionWithProfile();

    await closeSession(session);

    expect(await exists(session.userDataDir ?? '')).toBe(false);
    expect(sessions).not.toContain(session);
  });

  it('removes it when the browser close rejects', async () => {
    const session = await sessionWithProfile({ browser: fakeBrowser({ close: 'rejects' }).browser });
    const dir = session.userDataDir ?? '';

    // Must not throw: closeSession is awaited from the request path.
    await expect(closeSession(session)).resolves.toBeUndefined();
    expect(await exists(dir)).toBe(false);
  });

  it('shares one removal between concurrent callers', async () => {
    // The `profileRemovals` WeakMap: closeSession() and the 'disconnected'
    // handler both reap the same profile, and the second must await the first
    // rather than racing it.
    const session = await sessionWithProfile();
    const dir = session.userDataDir ?? '';

    await Promise.all([closeSession(session), closeSession(session)]);

    expect(await exists(dir)).toBe(false);
    expect(session.userDataDir).toBeNull();
  });
});

describe('a wedged browser does not stall the request path (issue #254)', () => {
  it('gives up on the graceful close and kills the process instead', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    const wedged = fakeBrowser({ close: 'hangs', alive: true, answersCdp: false, pid: 4242 });
    const session = await sessionWithProfile({ browser: wedged.browser });
    const dir = session.userDataDir ?? '';

    const closing = closeSession(session);
    // Puppeteer would wait its 180s protocolTimeout here. Nothing may.
    await vi.advanceTimersByTimeAsync(BROWSER_CLOSE_TIMEOUT_MS);

    // The negative pid takes Chromium's whole process group.
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');

    // And the profile is still reaped once the process is really gone, which
    // is the #208 contract this must not break.
    wedged.proc.exitCode = 137;
    wedged.proc.emit('exit');
    await closing;
    vi.useRealTimers();
    expect(await exists(dir)).toBe(false);
  });
});

describe('sweepSessions (issue #254)', () => {
  it('reaps an idle session that was marked unusable', async () => {
    const session = await sessionWithProfile();
    markSessionTainted(session, 'scrape aborted by client disconnect');
    const dir = session.userDataDir ?? '';

    await sweepSessions();

    expect(sessions).not.toContain(session);
    expect(await exists(dir)).toBe(false);
  });

  it('reaps a session whose CDP connection no longer answers, though it reports connected', async () => {
    // The #254 state: connected true, process alive, no answer to anything.
    const wedged = fakeBrowser({ alive: true, answersCdp: false });
    const session = await sessionWithProfile({ browser: wedged.browser });

    vi.useFakeTimers();
    const sweeping = sweepSessions();
    // The liveness probe times out, then the profile removal waits for the
    // process to exit before deleting underneath it (issue #208).
    await vi.advanceTimersByTimeAsync(CDP_PROBE_TIMEOUT_MS);
    wedged.proc.exitCode = 0;
    wedged.proc.emit('exit');
    await sweeping;
    vi.useRealTimers();

    expect(session.tainted).toBe(true);
    expect(session.taintReason).toBe('CDP liveness probe failed');
    expect(sessions).not.toContain(session);
  });

  it('leaves a healthy idle session in the pool', async () => {
    const session = await sessionWithProfile({ browser: fakeBrowser({ alive: true }).browser });
    const dir = session.userDataDir ?? '';

    await sweepSessions();

    expect(sessions).toContain(session);
    expect(session.tainted).toBe(false);
    expect(await exists(dir)).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('does not probe a session with pages in flight, but still kills a stuck one', async () => {
    const busy = await sessionWithProfile({ activePages: 1, lastActivity: Date.now() });
    const stuck = await sessionWithProfile({
      activePages: 2,
      lastActivity: Date.now() - STUCK_SESSION_TIMEOUT_MS - 1000,
    });

    await sweepSessions();

    expect(sessions).toContain(busy);
    expect(sessions).not.toContain(stuck);
    await closeSession(busy);
  });
});

describe('a Firefox request that cannot launch does not evict a pooled session', () => {
  it.each([
    ['an https:// proxy', { proxyUrl: 'https://proxy.example.com:8443' }, undefined],
    ['a missing Firefox binary', {}, path.join(os.tmpdir(), 'pricestalker-no-such-firefox')],
  ])('rejects %s before recycling an idle session', async (_case, options, executablePath) => {
    vi.stubEnv('FIREFOX_EXECUTABLE_PATH', executablePath ?? process.execPath);
    const pooled: BrowserSession[] = [];
    for (let i = 0; i < MAX_BROWSERS; i++) {
      pooled.push(await sessionWithProfile());
    }

    await expect(getBrowserSession({ browserEngine: 'firefox', ...options })).rejects.toBeInstanceOf(
      BrowserLaunchError,
    );

    expect(sessions).toHaveLength(MAX_BROWSERS);
    for (const session of pooled) {
      expect(sessions).toContain(session);
      await closeSession(session);
    }
  });

  it('raises the launch error, not a retryable null, to a request that joined a failing launch', async () => {
    const launch = Promise.reject(new Error('Failed to launch the browser process'));
    launch.catch(() => {});
    const launching = await sessionWithProfile({
      browser: null,
      launchPromise: launch,
      browserEngine: 'firefox',
      proxyUrl: null,
    });

    await expect(getBrowserSession({ browserEngine: 'firefox' })).rejects.toBeInstanceOf(BrowserLaunchError);

    expect(launching.activePages).toBe(0);
    await closeSession(launching);
  });
});
