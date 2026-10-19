import type { CapacitorConfig } from '@capacitor/cli';

// Native shell for STEIBOCK (iOS via Xcode). The game itself is the Vite build in dist/; this wraps it in a
// full-screen WKWebView with real haptics, a hidden status bar and a branded launch screen. See docs/IOS.md.
const config: CapacitorConfig = {
  appId: 'ch.chiralsports.steibock',
  appName: 'STEIBOCK',
  webDir: 'dist',
  backgroundColor: '#0D0E10',
  ios: {
    contentInset: 'never',
    backgroundColor: '#0D0E10',
    scrollEnabled: false,
    allowsLinkPreview: false,
  },
  plugins: {
    SplashScreen: {
      // src/native hides it as soon as the game's first frame is on screen; auto-hide is only the backstop
      launchAutoHide: true,
      launchShowDuration: 12000,
      launchFadeOutDuration: 350,
      backgroundColor: '#0D0E10',
      showSpinner: false,
    },
    StatusBar: {
      overlaysWebView: true,
      style: 'DARK',
    },
  },
};

export default config;
