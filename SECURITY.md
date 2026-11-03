# Security policy

## Report a vulnerability

Please report it privately. Do not open a public issue.

1. Open the repository on GitHub: https://github.com/RayanBayat/chrome-store-mcp
2. Go to the **Security** tab.
3. Press **Report a vulnerability**. This creates a private security advisory that only you and the maintainer can see.
4. Describe what you found, how to reproduce it, and what could go wrong.

If you cannot use that form, open a public issue that says only "I have a security report" and no details.
The maintainer will then contact you.

This is a small project run by one person. There is no fixed reply time. Reports are read and answered as soon as
possible.

## What is in scope

A problem is in scope when it breaks one of the safety layers in [docs/security.md](docs/security.md). For example:

- A tool call that sends a request that is not on the allowlist, or that reaches a host other than
  `chromewebstore.googleapis.com`.
- A way to publish, cancel, roll back or change a rollout without the confirmation that should have been asked.
- A way to make the confirmation dialog show text that hides what will really happen.
- A read tool that uses the write sign-in, or a sign-in that holds more permission than the one requested.
- An access token or refresh token that shows up in a tool result, an error message or a log.
- An upload that reads a file that is not a ZIP, or a path that should have been refused.
- Untrusted text (for example a store review) that gets around the "this is data" framing in a way the code could
  prevent.

## What is out of scope

- Setting `CWS_CONFIRM=none`. This turns the confirmation off on purpose.
- Someone who already has full control of your computer or your Google account.
- Anything inside Google's own services, including the Chrome Web Store API. Report those to Google.
- Weaknesses in a dependency that do not affect this server. Please report those to the dependency.
- Refresh tokens kept in environment variables in plain text. This is a known trade-off, written in the README.
- AI assistant behaviour that this server cannot control, other than the points listed above.

## Supported versions

Only the latest version gets fixes.
