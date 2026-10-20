# Changelog

Notable changes to HttpDash. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **OpenAPI documents in Service discovery, with versioned sync:** point a source at an OpenAPI (Swagger) document, JSON or YAML, and its server becomes a base URL variable (`{{lots_url}}`) while every operation becomes a request in a collection that uses it. The token the document needs is placed in the environment for the requests' auth. Each sync records the document's version and a fingerprint of its content, so an unchanged document changes nothing, and a new one is compared with the last: added, changed (query params, path variables, headers, body, auth, responses, names) and removed operations are listed before anything is written, and you apply them when you're ready. Your own work is kept: values you typed, scripts and tests, requests you added, and any field you edited that the document also changed (the report says so). A request whose operation left the document is deleted only if you never changed it. A document that changed without a new `info.version` is flagged, and each applied version goes into the source's history. "Sync when HttpDash starts" only checks such a source and tells you when a new version is waiting. A Custom JSON source pointed at an OpenAPI document now says to use this type.
- **Import from a link:** paste the URL of an OpenAPI/Swagger spec or a Postman collection in the Import dialog, with an optional Bearer token for protected specs. It's fetched with your proxy, certificates and SSL settings.
- **Show / hide on every masked field:** an eye button in each token, password and secret field (service discovery, Import from a link, request auth, team access token, certificate passphrase, the lock) shows what you typed or pasted, so a long token can be checked before it's used.

### Changed
- **Readable everywhere:** all text now meets WCAG AA contrast (4.5:1) in both themes. Toasts (success, warning, error) were hard to read, and so were the primary buttons in dark mode, muted labels and timestamps, status badges and method tags, placeholders in dark mode, and some code colors. `npm run audit:contrast` checks every screen in both themes.
- OpenAPI import: when every operation uses the same auth, it's set once on the collection and the requests inherit it.
- **License:** from this version on, HttpDash is licensed under the Functional Source License, Version 1.1, ALv2 Future License (FSL-1.1-ALv2). It stays free to use, at work too, and the source stays available; what it doesn't allow is offering HttpDash, or a fork, as a competing commercial product or service. Each version also becomes Apache 2.0 two years after its release. HttpDash 1.2.0 and earlier remain under the MIT License.

### Fixed
- **Service discovery names follow the registry type:** a new source was named "Consul services" whatever type you then picked, and so was the environment its first sync created. Until you type a name of your own, the name now follows the type (for example "Custom JSON services"), along with the environment it created. Sources and environments saved with the old name are corrected when HttpDash starts.

## [1.2.0] - 2026-10-21

### Added
- **Client certificates (mutual TLS):** add certificates per host (exact, wildcard or any) in **Settings → Certificates**, as CRT + KEY files or a PFX, with an optional passphrase. The Timeline shows which certificate was sent.
- **Custom CA certificate:** trust your company's certificate authority without turning off SSL verification.
- **Trust certificates installed on this computer** (on by default): CAs in the macOS Keychain, Windows certificate store or Linux system bundle are trusted, as in a browser, so company certificates work without setup.
- Command-line runner: Newman's certificate flags `--ssl-client-cert`, `--ssl-client-key`, `--ssl-client-passphrase`, `--ssl-client-cert-list` and `--ssl-extra-ca-certs`.
- Clear errors when a server requires a client certificate, rejects one, or the passphrase is wrong.
- **Streaming responses (Server-Sent Events):** `text/event-stream` responses, such as AI APIs streaming their answers, show each event live with its timing, can be stopped while keeping what arrived, and get an **Events** view.
- **WebSocket requests:** connect to `ws://` and `wss://` servers, send text or JSON messages (with variables and saved messages), and watch a live, filterable log of everything sent and received. The handshake uses your headers, inherited auth, cookies, client certificates, CAs and proxy; refused upgrades show the server's status and body.
- **Table view for JSON responses:** arrays of objects as sortable tables with a column per key, objects as key/value tables, nested values that expand in place, and a row filter. Long tables are virtual: only the rows on screen are drawn, so a 100,000-row response opens in about 0.1 s with under 70 rows in the page.
- **Export JSON tables** as Excel (.xlsx), CSV or a PNG image, following the filter and sort, with nested objects flattened into dotted columns.
- **YAML OpenAPI and Swagger import** (from files, drag and drop, paste and the CLI), with OpenAPI 3.1 support.
- OpenAPI imports now keep response examples, so the mock server works right after importing, and turn security schemes into auth (Bearer, Basic, API key, OAuth 2.0 with PKCE).

### Fixed
- OpenAPI import: chained and escaped `$ref`s, relative server URLs, JSON variants such as `application/vnd.api+json`, named examples, parameter examples and Swagger 2 form fields.

## [1.1.0] - 2026-10-21

### Added
### Changed
- **Large responses stay fast.** Responses over 2 MB show their first 512 KB with **Show all** and **Save to file** buttons, instead of freezing the window: a 20 MB JSON response now renders in about 40 ms instead of 2 seconds. Highlighting and code folding are turned off when you show all of a large response. The limit is in Settings → General.
- Switching between response tabs no longer re-formats the body.
- The window opens fully drawn instead of showing an empty frame first.
- **Smaller downloads:** builds keep only the English Chromium locale files (about 11 MB less per installer), and the extra Windows installer that bundled both x64 and ARM64 (193 MB) is no longer built.

### Fixed
- Postman collections using OAuth 2.0 with the password grant (`password_credentials`) now import correctly, and OAuth 2.0 settings export with Postman's parameter names, including the callback URL, PKCE method and client authentication.
- Public OAuth clients (no client secret) send `client_id` in the request body instead of an empty Basic Auth header.

### Security
- Scripts now run in a real sandbox: QuickJS, a separate JavaScript engine compiled to WebAssembly, with a fresh engine per script and limits on time (30 s), memory (256 MB) and stack depth. Scripts can no longer reach Node, files or other processes, which matters most for collections that arrive through team sync. Previously they ran in Node's `vm` module, which a script could escape.
- OAuth 2.0 access and refresh tokens are never written to team repositories; each person keeps their own when pulling the team's changes. Refresh tokens are also left out of exports with "Leave out secrets" and flagged by the secret scan.

## [1.0.0] - 2026-10-21

First release.

### Added
- Requests with any method, params, headers, every body type (raw, form-data with files, URL-encoded, binary, GraphQL) and cURL paste.
- Auth: Basic, Bearer, API key, Digest, OAuth 2.0 (client credentials and password grants) and AWS Signature v4, inherited through collections and folders.
- **Auth dependencies:** a login request runs first when the token is missing or expired, with optional retry on 401.
- Postman-compatible scripts (`pm.*` API, Chai, `pm.sendRequest`, `pm.setNextRequest`, CryptoJS, visualizer).
- Collection Runner with CSV and JSON data files.
- **Service discovery:** environments built and synced from Consul, Eureka, Kubernetes or a custom JSON registry.
- Import from Postman (v2.0/v2.1), OpenAPI 3, Swagger 2 and cURL; export everything as an HttpDash backup or as Postman files, with **Leave out secrets**.
- Code generation for 11 languages and tools.
- **Team sharing** through any git repository, with readable per-request files and conflict choices.
- Command-line runner (`httpdash run`) with CLI, JSON and JUnit reporters.
- Monitors, mock servers, secret scan and a local audit log.
- App lock with LDAP sign-in and a recovery code.
- macOS (Intel and Apple Silicon), Windows (x64 and ARM64) and Linux (AppImage and `.deb`, x64 and ARM64) builds.
- **Help** menu with **Check for Updates…**, release notes, documentation and issue links. The update check only runs when you choose it, so HttpDash makes no network calls of its own.
- `httpdash --version` in the command-line runner.
- MIT license, contributing guide, security policy, code of conduct, and issue and pull request templates.

[Unreleased]: https://github.com/gethttpdash/httpdash/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/gethttpdash/httpdash/releases/tag/v1.2.0
[1.1.0]: https://github.com/gethttpdash/httpdash/releases/tag/v1.1.0
[1.0.0]: https://github.com/gethttpdash/httpdash/releases/tag/v1.0.0
