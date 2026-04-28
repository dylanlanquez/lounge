# Kiosk setup — Galaxy Tab for receptionist

How to provision a Samsung Galaxy Tab so it boots straight into Lounge, runs full-screen with the system bar hidden, and stays locked into the app for an entire shift.

This is **Option 2** from the WiFi-switching discussion: pin the network at the OS / device-management level and let Lounge focus on the receptionist UX. The web app can never switch WiFi by itself.

---

## What you need before you start

- The Galaxy Tab (signed in to a Google account if you'll install from Play Store).
- The clinic's WiFi SSID and password.
- The Lounge URL: `https://lounge-coral.vercel.app` (or the production domain once it's set up).
- A receptionist Lounge sign-in (created via `./scripts/create-receptionist.sh`).

---

## Path A — Single-tablet kiosk (recommended for one clinic, one device)

This is the right path if you have a single tablet at one location. Zero MDM cost, zero ongoing infrastructure, ~20 minutes to set up.

### 1. Connect the tablet to WiFi

1. Settings → Connections → Wi-Fi.
2. Tap the clinic SSID and enter the password.
3. Long-press the SSID once connected → **Manage network settings** → tick **Auto reconnect**.

The tablet will now auto-rejoin this network on every boot. You'll only revisit this if the password changes or the router gets replaced.

### 2. Install Fully Kiosk Browser

Why Fully Kiosk: it's a free Android browser purpose-built for kiosk lockdown. It boots straight into a URL, hides the status bar, blocks navigation away, blocks system gestures, and survives reboots. The paid PLUS edition (~£8 one-off) adds remote management, but the free tier is enough for a single tablet.

1. Open Play Store → search **Fully Kiosk Browser** (publisher: Ozerov).
2. Install. Open it once so the launcher prompt appears.

### 3. Configure auto-launch + lockdown

Inside Fully Kiosk → Settings (the gear icon at the top right):

- **Web Content Settings → Start URL** → `https://lounge-coral.vercel.app/schedule`
- **Web Content Settings → Reload on Wakeup** → on (keeps the page fresh after the tablet sleeps)
- **Web Content Settings → Reload on Network Reconnect** → on
- **Universal Launcher → Show Top Bar** → off
- **Universal Launcher → Show Address Bar** → off
- **Universal Launcher → Show Navigation Bar** → off
- **Device Management → Enable Kiosk Mode** → on. Set a kiosk PIN (write this down — you'll need it to exit).
- **Device Management → Disable Status Bar Pull-down** → on
- **Device Management → Disable Volume Down Button** → on (optional; prevents accidental volume changes)
- **Power Settings → Keep Screen On** → on (stays awake while plugged in)
- **Power Settings → Screensaver** → off
- **Advanced Web Settings → Allow Camera Access** → on (consent photos / impressions need this)
- **Advanced Web Settings → Allow Microphone Access** → on (Google Meet)

### 4. Set Fully Kiosk as the default launcher

This step makes the tablet boot directly into Lounge instead of the Android home screen.

1. Settings → Apps → Choose default apps → Home app → **Fully Kiosk Browser**.
2. Or, on first home-button press after install, Android prompts you to choose a launcher — pick Fully Kiosk and tick **Always**.

### 5. Test

1. Reboot the tablet.
2. It should boot, auto-connect to WiFi, and land directly on `lounge-coral.vercel.app/schedule` in full-screen kiosk mode.
3. Try to swipe down from the top, swipe up from the bottom, hit the home button. None should escape Fully Kiosk.
4. Log a receptionist in. Confirm the Lounge top bar shows time + WiFi + battery.

---

## Operational tasks

### Exit kiosk for admin work

You **must** be able to get out of kiosk mode for OS updates, WiFi password changes, etc.

- Tap the screen 7 times in a corner (Fully Kiosk default exit gesture) → enter the kiosk PIN.
- Or pull down from the top with two fingers — opens Fully Kiosk's settings without leaving kiosk.

After admin work: Fully Kiosk → **Restart in Kiosk Mode** to relock.

### Change the WiFi password

1. Exit kiosk (above).
2. Settings → Connections → Wi-Fi → tap the SSID → **Forget**, then rejoin with the new password.
3. Confirm "Auto reconnect" is on.
4. Restart Fully Kiosk in kiosk mode.

### Change the Lounge URL (e.g. moving to a custom domain)

1. Exit kiosk.
2. Fully Kiosk → Settings → Web Content Settings → Start URL → update.
3. **Web Content Settings → Reload Start URL** to test it loads.
4. Restart in kiosk mode.

### Troubleshooting "tablet won't connect to WiFi"

- Check the kiosk status bar in the top-right of Lounge: shows `Offline` in red when the network is unreachable. If receptionist sees this, the device has lost the SSID or the router is down.
- Exit kiosk → Settings → Wi-Fi → reconnect. Reboot if that fails.
- The Lounge web app caches the schedule via the service worker, so the receptionist can still see today's existing appointments while offline. New writes will queue / fail until WiFi returns.

### Troubleshooting "Lounge boot loops or shows a white screen"

- Exit kiosk → Fully Kiosk → Settings → Advanced Web Settings → **Clear Cache** and **Clear Cookies**.
- Force-stop Fully Kiosk in Android Settings → Apps.
- Restart in kiosk mode. The app's PWA service worker will fetch a fresh build.

---

## Path B — Knox Configure (multi-device / multi-location)

Use this only if you have more than one tablet, or you're rolling out across multiple Venneir labs. Costs £6-£10 per device per year and requires a Samsung Knox account, but lets you push WiFi profiles, app updates, and lockdown rules to every tablet from one console.

### High level

1. Sign up for **Knox Configure Dynamic Edition** at [samsungknox.com](https://www.samsungknox.com/en/solutions/it-solutions/knox-configure).
2. Enrol each Galaxy Tab via the Knox Mobile Enrollment portal — you provide the IMEI / serial; Samsung links it to your Knox account at the factory.
3. In the Knox Configure console, create a **profile** that includes:
   - **Wi-Fi profile** with the clinic SSID + WPA2 password (pinned, can't be removed by the user).
   - **Kiosk profile** that pins Fully Kiosk Browser as the only allowed app.
   - **APN / VPN profile** if you also need cellular fallback.
   - **Disable** developer mode, factory reset, USB transfer, OS updates outside a maintenance window.
4. Push the profile to enrolled devices. Tablets pull the config on next reboot.

### Why Path B is overkill for a single clinic

Path A's Fully Kiosk + Auto-reconnect WiFi gets you 95% of the same lockdown for £8 instead of ~£10 / device / year. Knox Configure earns its keep when:

- You're managing 5+ tablets.
- Tablets need the same config across multiple sites without an admin physically touching each one.
- Compliance (UK GDPR / DPA 2018) requires a centrally-auditable device-management trail.

For Lounge as deployed at one Venneir lab on one tablet, Path A is the right call.

---

## Where to go next

- Path A done? Add the kiosk URL to a bookmark on your laptop too, so admin work on the same Lounge build doesn't require touching the tablet.
- If the clinic ever adds a second tablet (e.g. a chairside iPad for impressions), reassess Path B.
- Document the kiosk PIN in 1Password under `Lounge / Kiosk PIN` so you don't lose it when the receptionist changes.
