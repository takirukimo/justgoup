# STEIBOCK on iPhone (Xcode)

The repo contains a native iOS app (`ios/`, made with [Capacitor](https://capacitorjs.com)). It is the same
game as the web build, packaged as a real app. Compared with the browser it adds:

- a home-screen icon and a full-screen portrait app with no browser bars or status bar
- real haptics: iPhone Safari has no vibration API, so in the browser the game can't buzz
- a branded launch screen
- camera and photo-library access for **Import from photo** in the editor

The global leaderboard and community problems use the same Supabase backend as the web version.

## What you need

- A Mac with **Xcode** (latest from the Mac App Store) and **Node.js 22+** (`brew install node`)
- An **Apple ID**. A free account is enough to run the app on your own iPhone. TestFlight and the App
  Store need the paid Apple Developer Program ($99/year).
- Your iPhone and a USB cable (or the same Wi-Fi once paired)

## First run on your iPhone

```sh
git clone https://github.com/takirukimo/justgoup.git
cd justgoup
npm install
npm run ios:sync      # builds the game into dist/ and copies it into the Xcode project
npm run ios:open      # opens ios/App/App.xcodeproj in Xcode
```

In Xcode:

1. Click the **App** project in the left sidebar, then select the **App** target and open
   **Signing & Capabilities**.
2. Tick **Automatically manage signing** and pick your **Team**. With a free account this is your name
   (Personal Team); add your Apple ID under *Xcode → Settings → Accounts* if it's missing.
3. If Xcode says the bundle identifier is unavailable, change `ch.chiralsports.steibock` to something
   unique, such as `ch.chiralsports.steibock.yourname`.
4. Plug in the iPhone, unlock it and choose it as the run destination in the toolbar at the top.
5. Press **Run** (▶). The first build fetches the Capacitor Swift packages, which takes a minute.

On the iPhone, the first time only:

- Turn on **Settings → Privacy & Security → Developer Mode**. The phone restarts.
- With a free account, trust yourself under **Settings → General → VPN & Device Management → your
  Apple ID → Trust**.

Free-account builds stop launching after 7 days. Press Run in Xcode again to renew one. Paid accounts
are good for a year, and TestFlight builds for 90 days.

## Updating the app after code changes

```sh
git pull
npm run ios:sync
```

Then press **Run** in Xcode again. `ios:sync` rebuilds the web game and copies it into the app. You only
need it after the game code changes; Swift and Xcode settings live in `ios/` and are committed.

## TestFlight / App Store (paid account)

1. In App Store Connect, create the app with the bundle id from Signing & Capabilities.
2. In Xcode, set the run destination to **Any iOS Device (arm64)**, then choose **Product → Archive**.
3. In the Organizer, choose **Distribute App → App Store Connect → Upload**.
4. Add testers in TestFlight. Before publishing on the App Store you'll need screenshots, a privacy
   policy URL and the age rating. The game collects only a player name, scores and published problems.

## What's in the native shell

| File | What it does |
|---|---|
| `capacitor.config.ts` | app id and name, `dist/` as the web root, dark background, launch-screen timing |
| `src/native/native.ts` | runs only inside the app: turns the game's vibration patterns into Taptic Engine impacts, hides the status bar, and fades the launch screen once the first frame is drawn |
| `ios/App/App/Info.plist` | display name, portrait only, status bar hidden, camera and photo permission texts, no export-compliance prompt |
| `ios/App/App/Assets.xcassets` | app icon and launch splash, regenerated with `npm run ios:assets` |

The game's own UI already handles the notch and home indicator through `env(safe-area-inset-*)`.
