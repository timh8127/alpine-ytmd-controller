# Alpine Shell plugin

This repository is a plugin for Alpine Shell. Read these pages before you change it, and use only what they describe:

- https://alpineshell.com/docs/plugins/build-a-plugin.md
- https://alpineshell.com/docs/plugins/publish-a-plugin.md

## Rules

- `plugin.json` sits at the repository root. Its `id` is the developer organisation's slug, a dot and a name, all lowercase, such as `example-labs.hello`. The installed plugin folder has exactly that name.
- `version` is semver. Raise it for every release.
- Keep `apiVersion` at `1`. Set `engines.alpineShell` to the oldest Alpine Shell that has everything the plugin uses, such as `>=1.0.0`.
- The renderer is an ES module. Take React, `html` and the hooks from `window.alpine`. Never import or bundle React; point JSX at `window.alpine.h` and `window.alpine.Fragment`.
- The backend is a CommonJS module that exports a function taking `ctx`. Bundle every dependency into it: `node_modules` is never installed with a plugin.
- Start every channel name with the plugin id.
- Declare settings in `contributes.settings` in `plugin.json`. Keep any other data in `ctx.dataDir`.
- List what must not ship, such as sources, tests and lockfiles, in `.alpineignore`.
- Run the `build` script before testing the plugin in Alpine Shell.
- Never put secrets in the repository. It is public.

## This plugin

- `backend.js` talks to the YTMD Companion Server on `127.0.0.1:9863` only. It has no dependencies; keep it that way.
- YTMD rate limits: `/command` 2 per second, `/state` 1 per 5 seconds, 100 requests per minute overall. Keep the command queue in `backend.js`.
- `.alpine-publisher` holds the publisher verification code. It is meant to be public; do not change it.
