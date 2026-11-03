# Contributing

Thank you for helping. This is a small project, so the rules are short.

## Set up

You need Node.js 22.18 or newer and git.

1. Clone the repository:

   ```
   git clone https://github.com/RayanBayat/chrome-store-mcp.git
   ```

2. Install all packages, including the development tools:

   ```
   cd chrome-store-mcp && npm ci
   ```

3. Check that everything passes:

   ```
   npm run verify
   ```

Node runs the TypeScript in `src/` directly, so you do not need to build to try a change. Run the server from a clone
with `node src/index.ts`.

No test talks to Google or to your keyring. The tests use a real MCP client connected to the server in memory, with fake
network, fake credentials and fake dialogs.

## Commands

| Command                | What it does                                                              |
| ---------------------- | ------------------------------------------------------------------------- |
| `npm run lint`         | ESLint (typescript-eslint strict rules)                                   |
| `npm run format`       | Prettier, rewrites files                                                  |
| `npm run format:check` | Prettier, only checks                                                     |
| `npm run typecheck`    | TypeScript check, no output files                                         |
| `npm test`             | All tests with `node:test`                                                |
| `npm run build`        | Compiles to `dist/`                                                       |
| `npm run verify`       | Lint, format check, typecheck, tests and build, in this order             |
| `npm run maintenance`  | The monthly review helper. See [docs/maintenance.md](docs/maintenance.md) |

Run `npm run verify` before you open a pull request. It must pass.

## Style

- Short, plain code. Comments explain why, not what.
- Code with side effects (network, keyring, dialogs, clock) receives them as arguments, so tests can fake them.
- Error messages are written for a person. Do not put provider text or tokens in them.

## The most important rule: guards need tests

A **guard** is code whose job is to stop something bad: the allowlist, the ID patterns, the scope checks, the
confirmation, the upload checks, the redaction, the output cap. They are listed in [docs/security.md](docs/security.md).

If you add or change a guard, you must also add a test that **fails without it**. To check:

1. Write the guard and the test.
2. Remove or break the guard on purpose.
3. Run `npm test`. The new test must fail.
4. Put the guard back. The test must pass.

A test that passes with the guard broken protects nothing. Pull requests that weaken a guard, or add a write path
without a confirmation, need a clear reason in the description.

Also update [docs/security.md](docs/security.md) when you add or change a guard.

## How to add a new Google API method as a tool

Example: a new method `:something` on an item.

1. **Allowlist.** In `src/store/client.ts`, add one line to `ALLOWED_REQUESTS` with the exact method, the path (use the
   `ITEM_PATH` pattern) and the access level (`read` for GET, `write` for POST). Nothing can be sent without it.
2. **Client method.** In the `StoreClient` class, add a method that calls `this.request(...)` with the same access
   level.
3. **Tool.** In `src/tools/read-tools.ts` (read) or `src/tools/write-tools.ts` (write), register a tool named
   `cws_<something>`.
   - Use `itemArgs` and `resolveItemName` for the IDs.
   - Check every other argument with a strict zod schema (use `.regex`, `.min`, `.max`, enums).
   - A write tool that affects users must call `confirm(...)` before the client. Put only validated values in the
     confirmation text.
   - Wrap the body in `runTool(..., context.notice())`.
   - Set the annotations: `READ_ONLY` or `WRITE`.
4. **Tests.** Add tests in `test/`:
   - The allowlist tests in `test/client.test.ts` (including the count of entries).
   - A tool test in `test/tools.test.ts` that checks the method, the URL, the token that was used, and (for writes)
     that a "no" sends nothing.
   - Remember the rule above: the guards need tests that fail without them.
5. **Docs.** Update the tool table and notes in `README.md`, the file descriptions in `docs/architecture.md`, the layers
   in `docs/security.md`, and add a line to `CHANGELOG.md`. The server instructions in `src/server.ts` list the tools,
   so update them too.
6. **API surface file.** Add the method to `maintenance/api-surface.json`, so the monthly review knows we use it. See
   [docs/maintenance.md](docs/maintenance.md).

If the method needs a new OAuth scope, stop and open an issue first. The scopes are a security decision.

## Pull requests

- Keep each pull request about one thing.
- Say what changed and why. Say how you tested it.
- If you could not test something (for example it needs a real store item), say so. Please do not write down results you
  did not measure.

## Security problems

Do not open a public issue. See [SECURITY.md](SECURITY.md).
