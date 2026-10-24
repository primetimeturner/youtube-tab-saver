# Tab Saver for YouTube

A browser extension for Chrome, Edge, Opera, and other Chromium browsers (shown inside the extension as "YouTube Tab
Saver"). It saves all your open YouTube tabs into a YouTube playlist, including the videos you lined up with "Add to
queue", and then lets you choose which tabs to close.

Not affiliated with or endorsed by YouTube or Google.

## What it does

1. **Scan** - finds every open YouTube tab and reads the "Add to queue" queue of each video tab.
2. **Save** - adds the videos to a playlist on your YouTube account, in tab order. It finds the playlist by name or
   creates it (new playlists are private). Videos already in the playlist are skipped. When a playlist reaches
   YouTube's 5,000-video limit, it carries on in `Name [OVERFLOW]`, `Name [OVERFLOW 2]`, and so on.
3. **Close** - shows your tabs grouped by window, with quick selection buttons (duplicates, non-video tabs, incognito,
   this window, Shorts, invert). Tabs where something was not saved get a warning icon, and a warning button selects or
   deselects just those tabs.

## Install

From the store: Chrome Web Store or Opera add-ons (links once published; Microsoft Edge Add-ons to follow). Edge can
also install it from the Chrome Web Store.

From this repository:

1. Download this repository (Code > Download ZIP) and unzip it.
2. Open `chrome://extensions` (in Edge: `edge://extensions`, in Opera: `opera://extensions`) and turn on
   **Developer mode**.
3. Click **Load unpacked** and choose the unzipped folder.
4. Make sure you are signed in to YouTube in the same browser profile.

## Privacy

Everything runs in your browser. The extension talks only to youtube.com, using the session you are already signed in
with. Nothing is sent to the developer or to anyone else. See [PRIVACY.md](PRIVACY.md).

## How it works

- Saving uses the same requests the YouTube website makes when you use "Save to playlist". These requests are not a
  public API, so a change on YouTube's side can break the extension until it is updated. Every reply is checked, and the
  extension stops rather than guessing: it never adds a video it cannot confirm is missing from the playlist.
- YouTube keeps an "Add to queue" queue for only about a week. A sleeping tab's older queue can no longer be loaded,
  so only its open video is saved, and the tab gets a warning icon.
- Private and deleted videos can be accepted by YouTube without ever being added. The extension reports them as
  unavailable instead of saved.

## Troubleshooting

Every scan and save leaves a short report inside the extension. To copy it, open the extensions page, turn on
Developer mode, click "service worker" under this extension, and run this in the console that opens:

```
copy(JSON.stringify(await chrome.storage.local.get(['lastScanDiagnostics', 'lastDiagnostics']), null, 1))
```

The report contains video and playlist ids and YouTube's replies. It contains no cookies or passwords.

## Permissions

| Permission | Why |
|---|---|
| `tabs` | Find your open YouTube tabs (address and title) and close the ones you choose |
| `scripting` | Read the queue shown in a YouTube tab, and run the save inside a youtube.com tab with your signed-in session |
| `storage` | Remember playlist ids, the last save's result and the troubleshooting report, on your computer only |
| `https://*.youtube.com/*` | Limit all of the above to YouTube |