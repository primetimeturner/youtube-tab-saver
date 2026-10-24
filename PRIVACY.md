# Privacy policy - Tab Saver for YouTube

Last updated: October 24, 2026

Tab Saver for YouTube is a browser extension that saves your open YouTube tabs into a YouTube playlist on your own
account and helps you close those tabs. This policy explains what it handles and where that information goes.

## What the extension reads

- The addresses and titles of your open YouTube tabs (youtube.com only), so it can find videos to save and show the tab
  list for closing.
- The "Add to queue" list shown in those YouTube tabs.
- Your YouTube playlists, read from youtube.com with the session you are already signed in with, so it can find or
  create the playlist you name and skip videos already in it.

It does not read tabs on any other website, and it never sees your password. To send its requests the way the YouTube
website does, the extension reads YouTube's sign-in cookie inside the youtube.com page and turns it into the one-time
signature YouTube expects with each request. The cookie value is used only to make that signature; it is never
stored and never sent anywhere by the extension.

## Where information goes

- **To YouTube only.** To save videos, the extension sends requests to youtube.com from your browser, the same requests
  the YouTube website makes when you use "Save to playlist". These go to the YouTube account you are signed in to.
- **Nowhere else.** There is no server run by the developer. The extension contains no analytics, tracking or ads, and
  does not send or sell anything to the developer or any other party.

## What is stored, and where

All stored information stays in your browser's extension storage on your own computer:

- the names and ids of playlists the extension has used, to find them again faster;
- a short summary of the last save (counts, and which tabs were not saved and why), which is cleared when the browser
  closes;
- a troubleshooting report of the last scan and save (video ids, playlist ids and YouTube's replies), which you can
  copy yourself if you want to report a problem.

Removing the extension deletes all of this.

## Contact

Questions or problems: open an issue at https://github.com/primetimeturner/tab-saver-for-youtube/issues