# Contributing to HttpDash

Thanks for helping. Bug reports, fixes, features, docs and Postman collections that HttpDash gets wrong are all welcome.

## Before you start

- **Bugs:** open an issue with the [bug report form](https://github.com/gethttpdash/httpdash/issues/new/choose). A Postman collection, cURL command or backup that reproduces it (with secrets removed) makes it much quicker to fix.
- **Features:** open a feature request first for anything bigger than a small change, so we can agree on the approach before you write code.
- **Security problems:** don't open a public issue. Follow [SECURITY.md](SECURITY.md).
- **First contribution?** Look for issues labelled [`good first issue`](https://github.com/gethttpdash/httpdash/labels/good%20first%20issue).

## Set up

You need Node.js 22 or later and git.

```bash
git clone https://github.com/gethttpdash/httpdash.git
cd httpdash
npm install
npm start        # run the app
npm test         # run the unit tests
npm run cli -- run --help
```

There is no build step: the app is plain JavaScript, and changes show up on the next `npm start` (or **View → Reload** for renderer changes).

## Where things live

| Folder | What it holds |
| --- | --- |
| `src/core/` | The request engine: HTTP client, variables, auth, scripts, runner, importers, code generation, git sync. **No Electron imports**, so it runs under plain Node and in the CLI. |
| `src/main/` | Electron main process: windows, menus, IPC, storage. |
| `src/renderer/` | The UI, in plain JavaScript with CodeMirror 5. |
| `bin/` | The `httpdash` command-line runner. |
| `test/` | `node:test` unit tests, run against a local echo server in `test/helpers.js`. |
| `bench/` | The runner benchmark against Newman and Bruno (`npm run bench`). |
| `scripts/` | Chai vendoring (`npm run vendor`) and the contrast audit (`npm run audit:contrast`). |
| `build/`, `docs/` | The app icon for packaging, and the README's screenshots. |
| `website/` | The httpdash.com site. |

Put logic in `src/core/` whenever you can, so it can be tested without Electron and works in the CLI too.

Scripts run inside a QuickJS sandbox. The `pm` API lives in `src/core/sandbox-guest.js`, which runs *inside* the sandbox and can only reach the outside through the host functions in `src/core/sandbox.js`. Keep those host functions small, and have them take and return plain strings and numbers. `src/core/vendor/chai.min.js` is generated: after upgrading chai, run `npm run vendor`.

## Making a change

1. Create a branch from `main`.
2. Make your change, matching the style of the code around it: plain CommonJS, small functions, comments only where the *why* isn't obvious.
3. Add or update tests in `test/` for anything in `src/core/`. Run `npm test`; it must pass.
4. For UI changes, try them in both light and dark themes and in a narrow window, and run `npm run audit:contrast`: it opens the app, goes through its screens in both themes, and fails if any text is below WCAG AA contrast (4.5:1). Colors are tokens at the top of `src/renderer/css/app.css`; use the `-solid` tokens (`--ok-solid`, `--accent-solid`…) for fills behind white text.
5. Update `USERGUIDE.md` if you changed how something works (and `README.md` if it changes what HttpDash is), and add a line under **Unreleased** in `CHANGELOG.md`.
6. Open a pull request and fill in the template. CI runs the tests and builds macOS, Windows and Linux packages.

Commit messages are short and in the imperative, like the existing history: `Add WebSocket requests`, `Fix URL bar text jumping on focus`.

## Building packages

Every push and pull request runs the GitHub Actions workflow in `.github/workflows/build.yml`, which tests the app and then builds the installers for macOS, Windows and Linux (the file names are listed in [USERGUIDE.md](USERGUIDE.md#install-and-update)).

Download them from the workflow run's **Artifacts**. Pushing a tag such as `v1.0.0` also attaches them to a GitHub Release.

To build locally, run `npm run dist:mac` on a Mac, `npm run dist:win` on Windows, or `npm run dist:linux` on Linux or a Mac. Output goes to `dist/`.

Without certificates, the Mac build is ad-hoc signed and the Windows build is unsigned. To sign (and notarize on Mac), add these repository secrets; the workflow picks them up automatically:
- macOS: `MAC_CSC_LINK` (base64 .p12), `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
- Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`

## Website

The site for httpdash.com lives in `website/`: plain HTML, CSS and a little JavaScript, with no build step. The download buttons link to the latest GitHub release.

`.github/workflows/website.yml` uploads it to the web host over SSH whenever `website/` changes on `main`. It needs the `DEPLOY_*` repository secrets listed at the top of that file; until they are set, the job is skipped. To publish by hand instead:

```bash
rsync -rlvz --delete --exclude .well-known --exclude .htaccess website/ <user>@<host>:<web-root>/
```

## Source layout

```
src/core/      request engine (no Electron dependency, unit-tested)
  model.js        the shapes of requests, folders, collections and environments
  http-client.js  HTTP/HTTPS with timings, redirects, decompression, proxy, keep-alive
  executor.js     variables, auth, bodies, scripts, cookies, health, network -> response
  variables.js    {{variable}} resolution and dynamic variables ({{$guid}}, …)
  cookies.js      the cookie jar
  certificates.js client certificates (mutual TLS) and trusted CAs
  oauth2.js       OAuth 2.0 authorization URLs (with PKCE), callbacks and token requests
  sse.js          Server-Sent Events parsing
  websocket.js    WebSocket client on the same HTTP stack
  sandbox.js      runs scripts in a QuickJS (WebAssembly) sandbox
  sandbox-guest.js  the pm.* script API, running inside the sandbox
  vendor/         minified chai for the sandbox (npm run vendor)
  runner.js       collection runner and CSV/JSON data files
  dependency.js   auth dependencies (run the login first)
  discovery.js    service registries (Consul, Eureka, Kubernetes, custom JSON, OpenAPI)
  openapi-sync.js versioned sync of an OpenAPI document into a collection
  request-shape.js  checks a request against its operation in the spec
  balancer.js     spreads requests over instances; traffic by instance, payload and segment
  payloads.js     the variations a request is sent with
  compare.js      compares the answers of every instance
  dns-instances.js  a host's addresses in DNS, for Compare
  health.js       reads a health endpoint around a request
  network.js      addresses, octets, segments, reverse DNS and traceroute
  tunnels.js      SSH (ssh -D) and SOCKS5 tunnels, and which requests go through them
  traffic-report.js  traffic report as CSV, Excel, JSON, Markdown and HTML
  ai-api-spec.js  the AI agents' API (OpenAPI document); ai-server.js serves it, mcp.js bridges MCP
  send-command.js httpdash send: a curl-like command through the running app
  tabular.js      JSON tables as CSV and Excel workbooks
  postman.js      Postman / OpenAPI import and export
  backup.js       HttpDash backups: create, leave out secrets, merge or replace
  curl.js         cURL parser
  codegen.js      code snippet generators
  mock.js         mock server for a collection's examples
  secrets.js      secret scan
  audit.js        local audit log
  app-lock.js     app lock settings and recovery code; ldap-auth.js signs in
  repo-format.js  team repository file format
  gitsync.js      team sync through git
  update.js       version comparison for Help → Check for Updates
src/main/      Electron main process, IPC, persistence, preload bridge
src/renderer/  UI (plain JS + CodeMirror 5)
bin/           the httpdash command (run, list, send, mcp)
test/          node:test unit tests against a local echo server
bench/         runner benchmark against Newman and Bruno (npm run bench)
scripts/       chai vendoring and the contrast audit (npm run audit:contrast)
```

## Postman compatibility

Running Postman collections unchanged is one of HttpDash's main promises. If a collection or script behaves differently than in Postman, that's a bug: please report it with the smallest collection that shows the difference.

## License

By contributing, you agree that your contributions are licensed under the project's license, the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2), including its future Apache 2.0 grant.
