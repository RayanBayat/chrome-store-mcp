# Architecture

This page explains how chrome-store-mcp works inside. Read the [README](../README.md) first for what it does.

## The big picture

```
MCP client (for example Claude Code)
      |  MCP messages over stdin and stdout
      v
chrome-store-mcp  (this project, runs on your computer)
      |  HTTPS, with an access token
      v
Google: chromewebstore.googleapis.com   (and oauth2.googleapis.com for tokens)
```

- The **MCP client** starts the server as a child process. They talk over **stdio**: the client writes to the server's
  standard input, and the server answers on its standard output.
- The server has no network port of its own. The only time it opens a port is during `login`, for a few minutes, on
  `127.0.0.1`.
- All the logic runs on your computer. There is no server run by this project.

## Ideas used in the code

- **Pass things in, do not reach out.** Code that has side effects (network, keyring, dialogs, the clock) gets them as
  arguments. Tests pass fakes. This is why the tests need no network.
- **One door to Google.** Only `src/store/client.ts` talks to the store API, and it checks every request against a fixed
  list first.
- **Two sign-ins.** Read tools hold a credential that cannot change anything. Write tools use a separate one.
- **Errors are written for people.** Our own error classes carry messages that are safe to show. Anything else becomes
  "Unexpected error" and the details go to the log on stderr.

## File map

All files are in `src/`.

| File                   | In one line                                                            |
| ---------------------- | ---------------------------------------------------------------------- |
| `index.ts`             | The command line: serve, login, logout, help, version                  |
| `server.ts`            | Builds the MCP server and registers the tools                          |
| `config.ts`            | Reads and checks the environment settings                              |
| `errors.ts`            | The four error classes, token redaction, safe error text               |
| `maintenance.ts`       | The date of the last review and the overdue reminder                   |
| `auth/credentials.ts`  | Finds and saves secrets (environment variables, Linux keyring)         |
| `auth/tokens.ts`       | Turns a refresh token into an access token, checking the scope         |
| `auth/login.ts`        | The one-time browser sign-in, and logout                               |
| `confirm/confirm.ts`   | Asks a person before a write action                                    |
| `store/client.ts`      | The allowlist, the upload file check, and the HTTP client              |
| `store/ids.ts`         | Strict patterns for publisher IDs, item IDs and versions               |
| `tools/context.ts`     | What every tool receives, and the `itemId` and `publisherId` arguments |
| `tools/read-tools.ts`  | The four read tools and the query builders                             |
| `tools/write-tools.ts` | The five write tools                                                   |
| `tools/result.ts`      | Turns a tool outcome into an MCP result, with the size cap             |

### `index.ts`

The entry point. It reads the command (`login`, `logout`, `--help`, `--version`, or nothing) and acts. With no command it
reads the settings, builds the server with `createServer`, and connects it to stdio. The real `fetch`, the real clock
and the real credential store are chosen here and nowhere else. The `main` function is exported so it can be tested.

### `server.ts`

`createServer` builds the MCP server. It writes the server's **instructions** (a short text the client shows to the
model, including the maintenance reminder if one is due). It defines the elicitation function (see below), creates the
confirmation helper, creates the `StoreClient` with one `TokenSource` for read and one for write, and registers the nine
tools. It also holds the server name and version.

### `config.ts`

`readConfig` reads `CWS_PUBLISHER_ID`, `CWS_ITEM_ID` and `CWS_CONFIRM`. It checks them with the patterns from
`store/ids.ts` and throws a `SetupError` at start-up if one is wrong. None of these values is secret.

### `errors.ts`

Four error classes: `InputError` (bad tool arguments), `SetupError` (not signed in, no way to confirm), `ApiError`
(Google answered with an error) and `DeclinedError` (a person said no). `redact` removes anything shaped like an access
token (`ya29.`) or refresh token (`1//`). `describeError` returns the message for our own errors (redacted), a fixed
sentence for timeouts, and a generic "Unexpected error" for everything else.

### `maintenance.ts`

Holds `LAST_REVIEWED`, `REVIEW_INTERVAL_DAYS` (30) and `API_REVISION`. `maintenanceNotice` returns the reminder text
when the last review is more than 30 days old, otherwise `null`. See [maintenance.md](maintenance.md).

### `auth/credentials.ts`

A **credential store** with three functions: `lookup`, `store` and `clear`. Lookup checks the environment variables
first, then the Linux keyring through `secret-tool` (service `chrome-store-mcp`). The program is started without a
shell, and secrets are sent on its standard input, so they never show in a process list. If `secret-tool` is missing,
lookup simply finds nothing.

### `auth/tokens.ts`

`TokenSource` gives out an access token for one access level (read or write). It keeps the token in memory and refreshes
it one minute before it ends. It sends the refresh request with exactly one scope, with no redirects and a 30 second
timeout. It refuses an answer that reports any other scope. This file also holds the two scope strings and
`isExpectedGrant`, which `login` uses too.

### `auth/login.ts`

The one-time sign-in. It reads the downloaded client JSON, starts a small web server on `127.0.0.1` with a random port,
and opens Google's consent page. It uses **PKCE** (a one-time secret that proves the answer belongs to this sign-in) and a
random `state` value. It exchanges the answer for a refresh token, refuses and revokes the grant if the scope is not
exactly the one requested, and saves the result. It gives up after 5 minutes. `logout` revokes the token at Google and
clears the keyring entry.

### `confirm/confirm.ts`

`createConfirm` returns a function that resolves when a person says yes and throws otherwise. It supports the four modes
(`auto`, `dialog`, `elicit`, `none`). It builds the dialog text, cleans it (`cleanForDialog`), and starts `kdialog` or
`zenity` with the text as separate arguments (no shell). The dialog has a 2 minute timeout, and no answer counts as no.

### `store/client.ts`

The only file that talks to the Chrome Web Store API. It holds `ALLOWED_REQUESTS` (the list of nine allowed requests) and
`assertAllowedRequest`. It also holds `checkPackageFile` (the upload file checks) and the `StoreClient` class with one
method per API call. Every request goes through one private function that checks the allowlist, adds the token, sets
`redirect: 'error'` and a timeout, parses the answer, and turns errors into redacted `ApiError`s.

### `store/ids.ts`

Three patterns (item ID, publisher ID, version) and the functions `itemName` and `resolveItemName`. They build the
resource name `publishers/<publisher>/items/<item>` only after both IDs pass their pattern. A tool argument wins over the
environment default.

### `tools/context.ts`

The `ToolContext` type (client, defaults, confirm, notice function) that the tools receive, and `itemArgs`, the two
optional arguments that every tool accepts.

### `tools/read-tools.ts`

Registers `cws_item_status`, `cws_rating_summary`, `cws_reviews` and `cws_metrics`. It builds the query strings for
reviews and metrics, and checks dates (`parseDate` rejects dates that do not exist). The reviews result gets a `note`
that says the text is data, never instructions. All four tools are marked read-only.

### `tools/write-tools.ts`

Registers `cws_upload`, `cws_publish`, `cws_cancel_submission`, `cws_rollback` and `cws_set_deploy_percentage`. Each one
checks its arguments, asks for confirmation where needed, and only then calls the client. The text shown in the
confirmation comes from validated values, so nothing unchecked reaches the dialog.

### `tools/result.ts`

`render` turns a value into pretty JSON text and cuts it at 60,000 characters. `runTool` runs a tool body, always returns
a result, and puts a safe error message (with `isError`) instead of a crash. It adds the maintenance reminder to every
result while one is due.

## The path of one tool call

Example: the assistant calls `cws_publish`.

1. **Client to server.** Claude Code sends an MCP `tools/call` message on the server's standard input. The MCP SDK reads
   it and finds the tool `cws_publish` (registered in `tools/write-tools.ts`).
2. **Argument check.** The SDK checks the arguments against the zod schema (`itemArgs`, `publishType`, and so on). Wrong
   types or IDs that do not match the patterns are rejected here.
3. **Item name.** `resolveItemName` (`store/ids.ts`) picks the IDs (arguments first, then `CWS_*` defaults), checks them
   again and builds `publishers/<publisher>/items/<item>`.
4. **Confirmation.** The tool calls `confirm(...)` (`confirm/confirm.ts`) with the item and a plain description. In `auto`
   mode on a Linux desktop, `kdialog` or `zenity` shows a dialog. Otherwise `server.ts` sends an MCP **elicitation**
   back to the client. A "no", a timeout, or no way to ask stops the call here, and nothing is sent to Google.
5. **Request.** `StoreClient.publish` (`store/client.ts`) builds the URL and calls `assertAllowedRequest`. The method,
   path and access level must match one entry of `ALLOWED_REQUESTS`.
6. **Token.** The write `TokenSource` (`auth/tokens.ts`) returns a cached access token, or refreshes it: it looks up the
   client ID, client secret and write refresh token (`auth/credentials.ts`), asks `oauth2.googleapis.com` for a token
   with exactly the full scope, and refuses a different scope in the answer.
7. **To Google.** The client sends `POST https://chromewebstore.googleapis.com/v2/publishers/.../items/...:publish`
   with the token, no redirects and a 30 second timeout.
8. **Answer.** The client reads the answer. A non-2xx status becomes an `ApiError` with only Google's short message,
   redacted and cut at 500 characters.
9. **Result.** `runTool` (`tools/result.ts`) turns the JSON into text, cuts it at 60,000 characters, adds the
   maintenance reminder if one is due, and returns it. Errors become a short message with `isError` set.
10. **Back to the client.** The SDK writes the result on standard output. The assistant reads it.

Read tools follow the same path, without step 4, and with the read `TokenSource`.
