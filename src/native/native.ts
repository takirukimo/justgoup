// Native iOS shell glue (Capacitor, see capacitor.config.ts and docs/IOS.md). Loaded as its own module
// script from index.html so the game itself never has to know whether it runs in a browser or in the
// app. On the web it does nothing beyond one platform check and never loads the plugins.
//
// In the app it:
// - turns the game's navigator.vibrate() patterns into Taptic Engine impacts (iOS WebKit has no
//   Vibration API, so haptics only exist in the native build),
// - hides the status bar (Info.plist hides it at launch; the view controller would bring it back),
// - fades the native launch splash out once the game has drawn its first frame (the LOADING card in
//   index.html fades on the first frame), with the plugin's own auto-hide as the backstop.

import { Capacitor } from '@capacitor/core';

/** Longest single impact chain one pulse may become (ms). */
const MAX_PULSE_MS = 400;

async function installNative(): Promise<void> {
  const [{ Haptics, ImpactStyle }, { StatusBar }, { SplashScreen }] = await Promise.all([
    import('@capacitor/haptics'),
    import('@capacitor/status-bar'),
    import('@capacitor/splash-screen'),
  ]);

  // One vibration pulse of `ms` → impacts of matching weight: the game's 6-16 ms ticks read as light
  // taps, 20-40 ms as a firm knock, longer ones (falls, sends) as a heavy hit followed by a rumble.
  const pulse = (ms: number): void => {
    const style = ms < 10 ? ImpactStyle.Light : ms < 25 ? ImpactStyle.Medium : ImpactStyle.Heavy;
    void Haptics.impact({ style }).catch(() => {});
    for (let t = 45; t < Math.min(ms, MAX_PULSE_MS); t += 45)
      setTimeout(() => void Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {}), t);
  };
  let timers: number[] = [];
  const vibrate = (pattern: VibratePattern): boolean => {
    for (const id of timers) clearTimeout(id);
    timers = [];
    const steps = typeof pattern === 'number' ? [pattern] : Array.from(pattern);
    let at = 0;
    steps.slice(0, 16).forEach((raw, i) => {
      const ms = Math.max(0, Math.min(1000, Number(raw) || 0));
      // even entries vibrate, odd entries are pauses (the Vibration API's pattern format)
      if (i % 2 === 0 && ms > 0) timers.push(window.setTimeout(() => pulse(ms), at));
      at += ms;
    });
    return true;
  };
  Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true, writable: true });

  void StatusBar.hide().catch(() => {});

  // The LOADING card goes transparent on the game's first frame and is removed shortly after (or right
  // away on a fatal error); either one means there is something real to show.
  const boot = document.getElementById('boot');
  const observer = new MutationObserver(() => check());
  let hidden = false;
  const hideSplash = (): void => {
    if (hidden) return;
    hidden = true;
    observer.disconnect();
    void SplashScreen.hide({ fadeOutDuration: 350 }).catch(() => {});
  };
  const check = (): void => {
    if (!boot || !boot.isConnected || boot.style.opacity === '0') hideSplash();
  };
  if (boot?.parentNode) {
    observer.observe(boot, { attributes: true, attributeFilter: ['style'] });
    observer.observe(boot.parentNode, { childList: true });
  }
  check();
  setTimeout(hideSplash, 12_000);
}

if (Capacitor.isNativePlatform()) {
  installNative().catch((err: unknown) => console.warn('[native] setup failed', err));
}
