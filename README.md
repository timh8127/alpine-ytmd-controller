# YTMD Controller for Alpine Shell

Control [YouTube Music Desktop App (YTMD)](https://github.com/ytmdesktop/ytmdesktop) from the Alpine Shell topbar.

![YTMD Controller icon](assets/icon.png)

## What it does

**In the topbar**
- The current track with its album art, title and artist.
- Previous, play/pause and next buttons.
- Scroll over the widget to change the volume.

**In the popup** (hover the widget)
- Large album art, title, artist and album.
- A seek bar: click anywhere on it to jump there.
- Like and dislike, shuffle, and repeat (off, all, one).
- Volume slider and mute.
- **Up next**: the next songs in the queue. Click one to play it.

**In Settings > Plugins > YTMD Controller**
- Connect, reconnect or disconnect YTMD.
- Choose what the topbar shows: title and artist, title only, or nothing; the width of the track text; the album art; which buttons appear.
- Turn scrolling for volume and the Up next list on or off.
- Hide the widget while YTMD is closed.

## Set up

You need YouTube Music Desktop App **version 2** on the same PC.

1. In YTMD, open **Settings > Integrations** and turn on **Companion server**.
2. In the same place, turn on **Enable companion authorization**. YTMD turns it off again after 5 minutes or after the first approval.
3. Hover the YTMD widget in the topbar and choose **Connect**. The widget shows a 4-digit code.
4. YTMD opens a window for "Alpine Shell YTMD Controller". Check that it shows the same code and allow it.

The widget is connected from now on. It reconnects by itself whenever YTMD starts.

## Privacy

- The plugin only talks to YTMD on this PC, at `127.0.0.1` port `9863`. It sends nothing anywhere else.
- Album art is loaded from the image links that YTMD provides (YouTube's image servers), as in YTMD itself.
- The key YTMD hands out after you allow the connection is stored in the plugin's data folder. Alpine Shell deletes that folder when you uninstall the plugin.
- To revoke access, choose **Disconnect** on the plugin's settings page. To revoke it in YTMD as well, remove "Alpine Shell YTMD Controller" under **Authorized companions** in YTMD's Integrations settings.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| "YTMD not found" | Start YTMD and turn on **Companion server** in its Integrations settings. |
| "YTMD is not accepting new connections" | Turn on **Enable companion authorization** in YTMD, then choose Connect again. |
| "The request was denied in YTMD" | You have 30 seconds to allow the request in the YTMD window. Choose Connect to try again. |
| "YTMD no longer accepts this plugin" | The key was removed in YTMD. Choose Connect to pair again. |

## How it works

- `backend.js` runs in Alpine Shell's plugin backend process. It uses YTMD's [Companion Server API](https://github.com/ytmdesktop/ytmdesktop/tree/development/src/main/integrations/companion-server): it pairs once, follows YTMD's realtime feed over a WebSocket and forwards commands to the REST API, staying inside YTMD's rate limits. It has no dependencies.
- `index.js` draws the widget, the popup and the settings page with the React and helpers that Alpine Shell provides on `window.alpine`.

There is no build step: the files in this repository are the plugin.

## Install from source

Copy this folder to `%APPDATA%\alpine-shell\plugins\monkey-creations.ytmd-controller`, open Alpine Shell's **Settings > Plugins**, choose **Reload** and turn the plugin on.

## License

[MIT](LICENSE) © Monkey Creations

YTMD Controller is a community plugin. It is not affiliated with or endorsed by YouTube, Google, or the YTMD project.
