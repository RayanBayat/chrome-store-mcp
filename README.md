# chrome-store-mcp

An MCP server for the Chrome Web Store API v2.

**MCP** (Model Context Protocol) is the standard way AI assistants, such as Claude Code, call tools. This server gives
an assistant nine tools to read the state of your Chrome extension in the store, and to upload, publish and roll back
new versions. Every change that reaches your users asks a human first.

> Status: version 0.1.0, not released yet. There are 67 automated tests, and each safety guard was shown to fail its
> test when it was deliberately broken. It has **not** been run against Google's live API or a real store item yet
> (as of 2026-11-03).

## Quick install

You need Node.js 22.18 or newer and Git. There is nothing to download by hand: `npx` fetches the server from GitHub,
builds it and runs it.

1. Get an OAuth client file from Google Cloud (see [Set up Google Cloud](#set-up-google-cloud) below), then sign in once:

   ```
   npx -y github:RayanBayat/chrome-store-mcp login /path/to/client_secret.json
   ```

   Want the write tools too (upload, publish, rollback)? Run it once more with `login --write`.

2. Add the server to Claude Code:

   ```
   claude mcp add chrome-store --scope user -e CWS_PUBLISHER_ID=<publisher id> -e CWS_ITEM_ID=<item id> -- npx -y github:RayanBayat/chrome-store-mcp
   ```

That is all. The first start takes longer because `npx` downloads and builds the server; later starts reuse it.
It follows the `main` branch, so you get new commits automatically; every commit on `main` has passed CI. Its
dependencies, including indirect ones, are locked to exact versions (`npm-shrinkwrap.json`). To review updates before
you take them, stay on one commit by adding `#<commit>` after the repository name, for example
`github:RayanBayat/chrome-store-mcp#35e4f8c`.

For another MCP client, put this in its settings:

```json
{
  "mcpServers": {
    "chrome-store": {
      "command": "npx",
      "args": ["-y", "github:RayanBayat/chrome-store-mcp"],
      "env": {
        "CWS_PUBLISHER_ID": "<publisher id>",
        "CWS_ITEM_ID": "<item id>"
      }
    }
  }
}
```

### From a clone (to read or change the code)

```
git clone https://github.com/RayanBayat/chrome-store-mcp.git && cd chrome-store-mcp && npm ci --ignore-scripts
```

Then run `node src/index.ts` instead of `npx -y github:RayanBayat/chrome-store-mcp`. Node 22.18 and newer run the
TypeScript source directly, so there is no build step.

## What it can do

| Tool                        | Kind  | What it does                                                          | Asks a human first?           |
| --------------------------- | ----- | --------------------------------------------------------------------- | ----------------------------- |
| `cws_item_status`           | read  | Review and publish state, versions, rollout, warnings, last upload    | No                            |
| `cws_metrics`               | read  | Installs, uninstalls, active users, impressions, page views           | No                            |
| `cws_rating_summary`        | read  | Store rating and the number of ratings for each star                  | No                            |
| `cws_reviews`               | read  | User reviews, one page at a time                                      | No                            |
| `cws_upload`                | write | Replaces the draft package of an existing item with a ZIP             | No (see below)                |
| `cws_publish`               | write | Submits the draft for review                                          | Yes                           |
| `cws_cancel_submission`     | write | Cancels the submission that waits for review                          | Yes                           |
| `cws_rollback`              | write | Publishes an earlier version again, under a new higher version number | Yes (not with `validateOnly`) |
| `cws_set_deploy_percentage` | write | Raises the share of users who get the published version               | Yes                           |

Notes:

- `cws_upload` does not ask. It only replaces the draft package. Your users see nothing until the draft is published.
- `cws_publish` defaults to `publishType: STAGED_PUBLISH` (after approval it waits until you press Publish in the
  dashboard), `skipReview: false` and `blockOnWarnings: true`.
- `cws_rollback` with `validateOnly: true` only checks the request, so it does not ask.
- `cws_set_deploy_percentage` only works for items with more than 10,000 seven-day active users.
- Review text is written by the public. The result of `cws_reviews` says it is data, never instructions.

### What it cannot do

Google's API does not cover these, so this server cannot change them:

- Store listing text
- Screenshots and promo images
- Privacy practices answers
- Distribution settings
- Creating a new item. Upload the first version by hand in the Developer Dashboard.

Edit these in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole), or with a browser automation
tool that you control.

## Set up Google Cloud

The server talks to Google with your own OAuth client, so you need a small Google Cloud project. **OAuth** is the
standard way to let a program act for your Google account without knowing your password.

1. Open the [Google Cloud console](https://console.cloud.google.com/). Create a project or pick one.
2. Enable the **Chrome Web Store API** for that project (APIs and Services, Library).
3. Open **Google Auth Platform** (also called the OAuth consent screen). Choose the user type **External**. Fill in an
   app name and your email address.
4. Open **Data access** and add the scopes. A **scope** is one permission that you grant.
   - `https://www.googleapis.com/auth/chromewebstore.readonly` for the read tools.
   - `https://www.googleapis.com/auth/chromewebstore` as well, if you want the write tools.
5. Open **Audience**. Add your own Google account as a test user. Then press **Publish app** so the app is
   **In production**. An app that stays in Testing gets refresh tokens that expire after 7 days.
6. Open **Clients**. Create an OAuth client of type **Desktop app**. Download the JSON file.
7. Sign in. Each command opens Google's consent page in your browser:

   ```
   npx -y github:RayanBayat/chrome-store-mcp login /path/to/client_secret.json
   ```

   ```
   npx -y github:RayanBayat/chrome-store-mcp login --write /path/to/client_secret.json
   ```

   The second command is only needed for the write tools.

8. Delete the JSON file. The server saved what it needs.

Because the app is not verified by Google, the consent page shows a warning. For your own account you can pass it:
press **Advanced**, then continue.

### Find your publisher ID and item ID

Both are in the Chrome Web Store Developer Dashboard. The item ID is 32 letters (each from `a` to `p`) and is in the
item's URL. You can set them once with `CWS_PUBLISHER_ID` and `CWS_ITEM_ID`, or pass them to each tool call as
`publisherId` and `itemId`.

## Sign-ins and where secrets are kept

There are two separate sign-ins:

| Sign-in   | Scope                                                     | Used by              |
| --------- | --------------------------------------------------------- | -------------------- |
| read-only | `https://www.googleapis.com/auth/chromewebstore.readonly` | the four read tools  |
| write     | `https://www.googleapis.com/auth/chromewebstore`          | the five write tools |

Each sign-in gives the server a **refresh token**. A refresh token is a long-lived secret that the server swaps for a
short-lived access token whenever it needs one. Treat it like a password.

`login` refuses, and revokes, any grant that is not exactly the scope it asked for. Each token refresh also asks for
exactly that scope, and the server refuses an answer that reports other scopes.

The server looks for each secret in this order:

1. **Environment variables**: `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` (read sign-in) and
   `CWS_WRITE_REFRESH_TOKEN` (write sign-in). They work on every system. The values sit in plain text in your MCP
   settings.
2. **The Linux desktop keyring** (KWallet or GNOME Keyring), through the `secret-tool` command. A **keyring** is an
   encrypted store for secrets that your desktop manages. The service name is `chrome-store-mcp`. `login` saves there
   when it can. This is the better choice.

On macOS and Windows, use environment variables. A backend for the macOS Keychain and the Windows Credential Manager is
not built yet. Contributions are welcome. If `login` finds no keyring, it prints the values to set as environment
variables.

To sign out, run `npx -y github:RayanBayat/chrome-store-mcp logout` (add `--write` for the write sign-in). This revokes the token at Google and
removes it from the keyring. If you used environment variables, remove them from your settings too.

## Confirmation

Before a write action that affects users, the server asks a person. This matters because an AI assistant can be
tricked, for example by text inside a store review. A question that only a person can answer means a tricked assistant
still cannot publish.

Set the mode with the `CWS_CONFIRM` environment variable:

| Value            | What happens                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auto` (default) | On a Linux desktop session, a dialog through `kdialog` or `zenity`. Otherwise an **elicitation** if the client supports it. Otherwise the action is refused. |
| `dialog`         | Only the desktop dialog. Refused if there is none.                                                                                                           |
| `elicit`         | Only an elicitation. Refused if the client cannot show one.                                                                                                  |
| `none`           | No confirmation. Use this only for automation that you fully trust.                                                                                          |

An **elicitation** is an MCP feature: the server asks the client to show a question to the person and send back the
answer.

The dialog text is cleaned of markup and control characters. If nobody answers within 2 minutes, that counts as no.

## Other settings

| Variable           | Meaning                                               |
| ------------------ | ----------------------------------------------------- |
| `CWS_PUBLISHER_ID` | Default publisher ID for every tool (optional)        |
| `CWS_ITEM_ID`      | Default 32-letter item ID for every tool (optional)   |
| `CWS_CONFIRM`      | `auto`, `dialog`, `elicit` or `none` (default `auto`) |

A wrong value stops the server at start-up with a clear message.

## Command line

| Command                                          | What it does                                      |
| ------------------------------------------------ | ------------------------------------------------- |
| `chrome-store-mcp`                               | Serves MCP on stdio. Your MCP client runs this.   |
| `chrome-store-mcp login [--write] <client.json>` | Signs in once (read-only, or with `--write`)      |
| `chrome-store-mcp logout [--write]`              | Revokes a sign-in and removes it from the keyring |
| `chrome-store-mcp --help`                        | Shows the usage                                   |
| `chrome-store-mcp --version`                     | Shows the version                                 |

Run each command as `npx -y github:RayanBayat/chrome-store-mcp <command>`, or from a clone as `node src/index.ts <command>`.

## Safety in short

- Only nine fixed requests are allowed (exact method, path and sign-in level). Everything else is refused before it is
  sent.
- IDs are checked with strict patterns, so a tool argument cannot change where a request goes.
- No redirects, and every request has a timeout.
- Errors are cleaned of tokens. Details from Google are not shown.
- Output is capped at 60,000 characters.
- Uploads must be an absolute path to a real `.zip` file within the size limit, starting with the ZIP magic bytes.

The full list, with the file and test for each layer, is in [docs/security.md](docs/security.md).

## Maintenance reminder

Google can add or retire API methods, and dependencies get updates. The file `src/maintenance.ts` records the date of
the last review. While that date is more than 30 days old, every tool result ends with a reminder. The review itself is
described in [docs/maintenance.md](docs/maintenance.md).

## Troubleshooting

| Message or symptom                               | Meaning and fix                                                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Not signed in for read access`                  | No read sign-in is stored. Run `login`. (For write access: `login --write`.)                                                           |
| `invalid_grant`                                  | The sign-in expired or was revoked. In Testing mode refresh tokens last 7 days. Run `login` again, and publish the app (step 5 above). |
| `There is no way to ask you for confirmation`    | Install `kdialog` or `zenity`, use an MCP client that supports elicitation, or set `CWS_CONFIRM=none` if you accept the risk.          |
| 403 from the store                               | The Google account is not the publisher of the item, or the Chrome Web Store API is not enabled in your Google Cloud project.          |
| A maintenance reminder at the end of each result | The last review is more than 30 days old. See [docs/maintenance.md](docs/maintenance.md).                                              |

## Why not the existing `cws-mcp` package?

There is already an npm package called `cws-mcp`. I read version 2.0.2 on 2026-11-03. Its code is honest: it has no
telemetry and talks only to Google endpoints. I still chose to write a different server, for these reasons:

- Its upload, publish, cancel, rollout and listing-edit tools are always on and ask for no confirmation.
- Publish defaults to going live right after approval, and it has a skip-review option.
- Its listing tools drive the real dashboard with Playwright and keep a full Google account session on disk in
  `~/.cws-mcp-profile`.
- Its upload reads any file path.
- Its setup runs `npx -y cws-mcp` and it ships no lockfile, so every start can install newer versions of it and of its dependencies.

If you want listing edits through a browser, that package does something this one does not. This server does less on
purpose.

## Dependencies

| Package                     | Version | Use                             |
| --------------------------- | ------- | ------------------------------- |
| `@modelcontextprotocol/sdk` | 1.32.2  | Runtime. The official MCP SDK.  |
| `zod`                       | 4.6.7   | Runtime. Checks tool arguments. |

Both are pinned to an exact version, and `npm-shrinkwrap.json` locks every indirect dependency, also for npx installs. With transitive packages there are about 95
packages. `npm audit --omit=dev` reported 0 vulnerabilities on 2026-11-03.

I used the official SDK instead of writing the protocol layer by hand, so new MCP protocol versions arrive as SDK
updates.

Development tools: TypeScript 6.0.3 (TypeScript 7 exists, but typescript-eslint supports up to 6.0), ESLint 10 with a
flat config and typescript-eslint `strictTypeChecked`, Prettier, and `node:test` for tests.

## More documents

- [docs/architecture.md](docs/architecture.md): how it works, a map of the files, and the path of one tool call
- [docs/security.md](docs/security.md): the threat model and every safety layer
- [docs/maintenance.md](docs/maintenance.md): the monthly review
- [CONTRIBUTING.md](CONTRIBUTING.md): how to set up and change the code
- [SECURITY.md](SECURITY.md): how to report a vulnerability
- [CHANGELOG.md](CHANGELOG.md)

## Licence

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 Rayan Bayat.
