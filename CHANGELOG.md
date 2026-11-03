# Changelog

All notable changes to this project are written here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## 0.1.0 - unreleased

The first version.

### Added

- An MCP server for the Chrome Web Store API v2, with nine tools.
- Four read tools: `cws_item_status`, `cws_metrics`, `cws_rating_summary`, `cws_reviews`.
  They use a read-only sign-in and send GET requests only.
- Five write tools: `cws_upload`, `cws_publish`, `cws_cancel_submission`, `cws_rollback`, `cws_set_deploy_percentage`.
  They use a separate write sign-in and send POST requests only.
- A human confirmation for every write except `cws_upload` (and `cws_rollback` with `validateOnly`).
  Set the mode with `CWS_CONFIRM`: `auto`, `dialog`, `elicit` or `none`.
- Two separate OAuth sign-ins (read-only and full). The login refuses and revokes any grant that is not exactly the
  requested scope, and each token refresh asks for exactly that scope.
- Credentials from environment variables, or from the Linux desktop keyring through `secret-tool`.
- A fixed list of allowed requests (method, path and sign-in level), strict checks on every ID, no redirects, request
  timeouts, redacted error messages, and a 60,000 character cap on tool output.
- Upload checks: absolute path, `.zip` ending, a real file, size limit, and ZIP magic bytes.
- Review text is marked as untrusted data in the tool result.
- A maintenance reminder on every tool result while the last review is more than 30 days old.
- Command line: `login [--write] <client.json>`, `logout [--write]`, `--help`, `--version`.
- 67 automated tests; each safety guard was shown to fail its test when deliberately broken.

### Not yet done

- It has not been run against Google's live API or a real store item.
- No Keychain (macOS) or Credential Manager (Windows) support. Use environment variables there.
- No npm package yet.
