import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ScreenWakeLock } from "../shared/wakeLock.ts";
import { FakeBrowser } from "./helpers/browser.ts";

/** Lets requests started from a visibilitychange listener finish. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe.serial("screen wake lock", () => {
  let browser: FakeBrowser;
  beforeEach(() => { browser = new FakeBrowser(); browser.install(); });
  afterEach(() => browser.restore());

  test("holds one screen lock while wanted and releases it", async () => {
    const wakeLock = new ScreenWakeLock();
    await wakeLock.acquire();
    await wakeLock.acquire();
    expect(browser.wakeLockRequests).toBe(1);
    expect(browser.activeWakeLocks).toHaveLength(1);
    await wakeLock.release();
    expect(browser.activeWakeLocks).toHaveLength(0);
    await wakeLock.release();
  });

  test("requests the lock again when the page is shown, since hiding the page releases it", async () => {
    const wakeLock = new ScreenWakeLock();
    await wakeLock.acquire();
    browser.setVisibility("hidden");
    await settle();
    expect(browser.activeWakeLocks).toHaveLength(0);
    expect(browser.wakeLockRequests).toBe(1);
    browser.setVisibility("visible");
    await settle();
    expect(browser.wakeLockRequests).toBe(2);
    expect(browser.activeWakeLocks).toHaveLength(1);
  });

  test("stays released after release, even when the page is shown again", async () => {
    const wakeLock = new ScreenWakeLock();
    await wakeLock.acquire();
    await wakeLock.release();
    browser.setVisibility("hidden");
    browser.setVisibility("visible");
    await settle();
    expect(browser.wakeLockRequests).toBe(1);
    expect(browser.activeWakeLocks).toHaveLength(0);
  });

  test("ignores a refused request and tries again when the page is shown", async () => {
    browser.grantWakeLock = () => Promise.reject(new Error("NotAllowedError"));
    const wakeLock = new ScreenWakeLock();
    await wakeLock.acquire();
    expect(browser.activeWakeLocks).toHaveLength(0);
    browser.grantWakeLock = () => Promise.resolve();
    browser.setVisibility("visible");
    await settle();
    expect(browser.wakeLockRequests).toBe(2);
    expect(browser.activeWakeLocks).toHaveLength(1);
  });

  test("lets go of a lock granted after it was released", async () => {
    const grant = Promise.withResolvers<void>();
    browser.grantWakeLock = () => grant.promise;
    const wakeLock = new ScreenWakeLock();
    const acquiring = wakeLock.acquire();
    await wakeLock.release();
    grant.resolve();
    await acquiring;
    expect(browser.wakeLocks).toHaveLength(1);
    expect(browser.activeWakeLocks).toHaveLength(0);
  });

  test("does nothing where the Wake Lock API is unavailable", async () => {
    browser.install(true, false);
    const wakeLock = new ScreenWakeLock();
    await wakeLock.acquire();
    browser.setVisibility("visible");
    await settle();
    await wakeLock.release();
    expect(browser.wakeLockRequests).toBe(0);
  });
});
