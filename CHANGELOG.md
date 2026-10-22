# Changelog

Notable changes to HttpDash. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Data files for AI agents:** `startRun` takes `data` (one object per iteration), and through MCP `dataFile`, the path to a CSV or JSON file that `httpdash mcp` reads and sends. Iterations default to the number of rows.
- **Collection and folder scripts for AI agents:** `createCollection` and `createFolder` take a pre-request and test script, and the new `updateCollection`, `updateFolder` and `getFolder` change and read them.
- **User guide:** a [Data files](USERGUIDE.md#data-files-data-driven-runs) section, including how to send nested JSON from a data file.
- **Preview tabs:** a single click in the sidebar (a request, environment, globals, discovery source, monitor or history entry) opens a preview tab, its title in italics, which the next single click replaces, so looking around doesn't pile up tabs. It stays as soon as you use it:
  - an edit, a send or a save
  - a double-click on the tab or on the item in the sidebar
  - **Keep open** in the tab's menu.
- **Where a new request goes:** a request that isn't in a collection yet says so in its header ("Not saved yet · Save… puts it in Orders API / Orders"). Save suggests the folder you were working in when you opened it, instead of the first collection.
- **Keyboard shortcuts:**
  - **Undo and redo for the whole request** (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y): typed text and changes such as a deleted header, a new method or a switched version, in one history per tab. Undoing back to the saved request makes the tab clean again.
  - **Find** (Ctrl/Cmd+F) searches the response from anywhere in a request tab, or the editor you're typing in; **Ctrl/Cmd+Shift+F** searches requests in the sidebar. Both are in a new **Edit** menu section.
  - **Tabs:** Ctrl+Tab and Ctrl+Shift+Tab (also Ctrl+PageDown / PageUp and Ctrl/Cmd+Shift+] / [), and Ctrl/Cmd+1 to 9.
  - **Ctrl/Cmd+Enter on a WebSocket tab** connects, and once connected sends the message.
  - The user guide lists every shortcut.
- **Zoom in Settings:** **Settings → Appearance → Zoom** has − and + buttons that step the whole window from 70% to 130% in steps of 10% and a Reset to 100%. The zoom is kept for the next start, and Ctrl/Cmd + = / − / 0 and the View menu move the same setting.
- **Search sees open tabs:** a tag, name or URL typed in an open tab counts in the sidebar search and tag suggestions right away, before it's saved. Open tabs that aren't saved yet appear under **Open tabs, not saved**.

### Changed
- **Search finds more of what you type:** each word is matched on its own, in any order (`create order`, `post orders`), the method and folder and collection names count, and when nothing matches exactly, close matches one typo away are shown with a note (`ordrs` finds "orders"). The Runner's request filter and the AI API's `searchRequests` match words and folders the same way.
- **README:** a sharper summary (service-heavy backends and AI agents) and a **How it compares** table against Postman, Insomnia, Bruno, Hoppscotch and Yaak, listing only what their documentation shows.
- **Resizers are easier to find:** the bar between the request and the response is 6 px with a grip in the middle, and the sidebar and console edges show a grip too; all turn the accent color on hover and while dragging.
- **Documentation:** the README is now what HttpDash is, a quick guide and its sponsors; how every feature works moved to [USERGUIDE.md](USERGUIDE.md), which **Help → Documentation** opens. Building, the website and the source layout moved to [CONTRIBUTING.md](CONTRIBUTING.md).
- **Dragging in the sidebar:**
  - It shows exactly where an item will land: a thin line with a dot, at the right indentation, above or below a request (by which half of the row you're over); the middle of a folder highlights it to drop into, and its edges place the item before or after it.
  - A closed folder opens when you hold an item over it, and the item being dragged fades.
  - You can drop after the last request in a folder.

### Fixed
- The "Drop files to import" overlay appeared when moving a request in the sidebar (or a tab) and stayed on screen after the drop. It now shows only for files dragged in from outside, and always closes when a drag ends.
- **History opens the saved request:** a history entry of a saved request now opens that request, so a tag or an edit goes on it. That includes one an AI agent saved with `sendAdHoc` or `httpdash send --save`. **Open as a new request** still opens a copy as it was sent.
- Ctrl/Cmd+F in the URL bar opened a search box inside the one-line URL; it now searches the response.
- **A narrow response pane:** the status, time and size line was drawn over the response tabs. It now moves below them, and the tabs wrap instead of being cut off.
- **The Windows icon** looked smaller than other apps' on the taskbar: it kept the macOS icon's empty border. Windows now gets its own icon that fills the square (`build/icon.ico`, made with `npm run icon:win`).
- **The request header:** a long version label (`GET /api/…`) ran under **Versions** and **Save** when the header was narrow. It now shortens with an ellipsis, the folder path giving way first.
- **Small or zoomed-in windows:** the request's header, URL and tabs could fill its half and leave the editor no room; the editor now keeps at least 120px and the half scrolls. In a narrow request header the version chip and "Not saved yet" step aside rather than shrink to a letter, and the response toolbar wraps instead of crushing the language picker.
- **The sidebar** could be dragged so narrow that the search box was too short to read; its minimum width is now 300px, including a width saved before.
- Help text that said more than the app does:
  - **Show auto-generated** no longer lists `Cache-Control` when **Send no-cache header** is off.
  - The segment size setting says it applies to the Timeline (Traffic and trace route use /24 and /64).
  - **Trust certificates installed on this computer** names the Linux system bundle too.
  - The search placeholders no longer suggest typing `#` before a tag.

## [1.7.0] - 2026-10-21

### Added
- **Test an endpoint like curl, and keep it:** for AI agents and the terminal.
  - **AI API:** `sendAdHoc` can run a request inside a collection and folder (by name or id), so their auth and automatic login apply. With `save`, a request that succeeded is kept there:
    - with its response as an example and the tag `ai`
    - updating the request with the same method and URL instead of duplicating it
    - creating missing folders and the collection
    - `saveIf: "always"` keeps any answer; saving needs the Edit permission, and the AI access history says where it was saved.
  - **`httpdash send`:** a curl-like command that sends through the running app, with its environments, logins, cookies, certificates and tunnels: `-X`, `-H`, `-d` / `--json` (with `@file`), `-e`, `-c` / `--folder` / `--save` / `--save-always` / `--name` / `-t`, `-i`, `-v` and `-f`. The body goes to stdout; what was saved goes to stderr.

## [1.6.0] - 2026-10-21

### Added
- **Tunnels into internal networks:** reach services on a private network (a plant, a data center, a cluster) without a VPN, from **Settings → Tunnels**.
  - **Two kinds:** an **SSH jump host**, run with your system's `ssh -D` so your keys, agent, `~/.ssh/config` and known hosts apply (optional user, port, key file and further jump hosts; batch mode, so never a password prompt; new host keys only if you allow it), or a **SOCKS5 proxy** with an optional user name and password.
  - **Which requests:** a tunnel carries the hosts you list (`*.mes.corp`, `10.42.0.0/16`), or an environment sends all its requests through one. Names are resolved on the far side.
  - **Everything goes through it:** Send, Runner, Monitors, Compare, health reads, WebSockets, service discovery, OAuth and imports.
  - **What you see:** the Timeline shows the tunnel's time and that the address is on the far side, the status bar shows an open or failed tunnel, and **Open / Check** can try a `host:port` through it.
  - **CLI:** uses a backup's tunnels, or `--socks5 host:port`, and `--no-tunnels` ignores them.
  - "Leave out secrets" exports empty SOCKS passwords.

### Changed
- The network trace waits at most 0.4 s for DNS details (they finish in the background and are kept for a minute), and doesn't ask DNS servers about `localhost` or single-label names, so a slow or blocked DNS server never holds up a response.

## [1.5.0] - 2026-10-21

### Added
- **Where a request went on the network:** the Timeline has a **Network** section showing:
  - the host's alias chain (CNAME)
  - every address it resolves to, with TTLs, and the one connected to
  - each address split into octets with its segment highlighted (`10.42.7.0/24`), its kind (private, shared/VPN, loopback, link-local, public) and its reverse-DNS name
  - whether it is on one of your own segments
  - your own address and the network adapter the request left from.

  Split DNS (the resolver and DNS servers disagreeing) is flagged, and a proxy is noted. **Trace route** runs the system's traceroute and lists each hop with its segment. Traffic gets a **By network segment** table (and sheet, in every export format) when instances answer from more than one segment. Compare shows each instance's address. The AI API returns the trace with `sendRequest` and the addresses with `compareInstances`. Segment size (/24 and /64 by default) and the trace itself can be changed in **Settings → General**.
- **Health while it runs:** give a request, folder or collection a health URL (`/healthz`, `/actuator/health`, or a full URL with variables) and HttpDash reads it before the request is sent, every 250 ms while it is in flight (the first reading as it goes out), and after it answers. A path is read on the request's own host, so a request sent to one instance reads that instance's health, also when comparing instances. The response's **Health** tab says whether the service stayed healthy, lists the fields that changed (before, range during, after) with a small chart of each over time, and shows every reading and how long the health endpoint took. Watch only some fields, send the request's Authorization header if the endpoint needs it, and use **Read it now** to see what an endpoint returns and pick fields. The Runner shows one health line per request, the CLI prints it, and the AI API's `sendRequest` returns it. Readings never fail the request: an endpoint that can't be reached is an unhealthy reading. Health settings travel with team sharing.

### Fixed
- The Timeline's **Remote address** was missing for requests on a kept-alive connection.

## [1.4.0] - 2026-10-21

### Added
- **Request versions, with their responses:** every distinct version of a request you send by hand (method, URL, params, headers, body, auth) is kept with the response it got, so you can switch back to any of them from **Versions** in the request's header, and see that response straight away. Sending the same thing again doesn't make a new version. Name and tag versions ("released orders", #smoke) in **Manage versions**; named and tagged versions show up in the sidebar search (and its suggestions) under their request. Runs and monitors don't add versions. Versions are your own working history: they stay in your workspace, not in the collection, so they aren't exported or shared; each request keeps 50, the named and tagged ones longest.
- **Warnings when a request no longer fits its API:** for an API that comes from an OpenAPI source, each operation's shape is kept at every sync (its query and header parameters, required ones and allowed values, and its JSON body's fields and types). A request, and each of its versions, is checked against it: a banner says when its operation is gone or deprecated, a required parameter or field is missing, a value isn't one the spec allows, a field has the wrong type, or it sends something the spec doesn't know. Versions that no longer fit are marked ⚠ in the versions menu.
- **AI agents can use HttpDash (OpenAPI and MCP):** turn on **Settings → AI access** and agents such as Claude can read your collections, environments and history; send requests and read the responses; set up the Runner (a collection, folder, chosen requests or tags), follow the run and read the results; compare instances; sync discovery and read traffic; create collections, folders and requests and change them; and see and use the screen, with a snapshot of the visible controls (tabs, tree items, buttons, fields, table toggles, scrollable areas) to click, type into, expand and scroll, plus screenshots of the window or any part of it. The API is described by an OpenAPI 3.1 document, and `httpdash mcp` serves it to Claude Code and Claude Desktop as tools. You choose what's allowed (read, run, edit, control the screen, reveal secrets; credentials and secret variables stay masked otherwise). It listens on this computer only, needs a token, refuses web pages, and stops while the app is locked or paused. The status bar shows when an agent is working, each screen action outlines what it touched, and **AI access** lists every call with its permission, result and time.
- **Request tags and a search that suggests:** tag requests (smoke, orders, admin, as many as you like) in a field under the request's name that suggests the tags already in use, with how many requests have each. The sidebar search turns into a dropdown as you type, built from every request: tags, methods, URLs and names, grouped, most used first. Pick one and it becomes a chip; chips combine (every tag, any of the methods, and the URL, name and text you add). Keyboard: ↑ ↓, Enter, Esc, and Backspace removes the last chip; "tag:", "method:", "url:" and "name:" narrow the suggestions. The Runner's request picker uses the same search, so "#smoke" then All runs the smoke tests, and the CLI has `--tag` (repeat it to require several). Tags travel with team sharing and survive a Postman export and import.
- **Pick exactly which requests a run includes:** the Runner shows the folder being run as a tree, with a checkbox on every request and every folder (a folder's checks or unchecks everything inside it, and shows how many are selected). A filter finds requests by name, method, URL or folder, and All / None apply to what it shows, so "skip every POST" or "only the Orders folder" is two clicks. The count and the Run button ("Run 12 requests") update as you pick, and the Run button stays in view.
- **Environment colors:** give an environment a color (red for production is a good habit) and, while it's active, the top and bottom bars take a faint tint of it, with a matching dot by the environment picker and in the list. Every color keeps text at WCAG AA contrast in both themes.
- **Compare instances:** when a request's URL uses a service from service discovery with two or more healthy instances (the source is synced again first, so the instances are the registry's current ones), or a host that resolves to several addresses in DNS (round-robin DNS, Kubernetes headless services; each address is sent to directly, with the host name kept for TLS and the Host header), **Compare** next to Send sends it to every instance at once and compares their answers: status, headers and every field of a JSON body. The instance that answers differently from the rest is named, with each difference (say, `X-Version` 2.3.0 where the others say 2.4.1, or a missing `qty`), so a pod left on an old release, a stale cache or a config difference shows up in one click. Values that differ on every instance by nature (ids, timestamps, the instance's own name) are set apart, and can be ignored for the request with one click (`items[*].updatedAt` covers every item). Headers that always vary, such as `Date` or request ids, are ignored. Each instance's status, time and test results are listed, and **Show** opens any instance's full answer. The same payload goes to every instance; a POST, PUT, PATCH or DELETE asks first, as it runs once per instance. Variables changed by scripts are not kept, except a token saved by an auth dependency, which logs in once.

### Changed
- **Calmer notifications:** toasts are now cards in the app's own colors, with a thin colored bar and an icon (green check, amber warning, red cross, blue info) instead of a solid colored fill. Errors are announced to screen readers as alerts.
- **Faster, especially on HTTPS:** connections are kept open and reused (keep-alive), so requests to a host you just called skip DNS, TCP and the TLS handshake, usually the slowest part of a request to a real API. Each client-certificate setup keeps its own connections, and a connection the server closed while idle is retried once on a new one, as browsers do. The timeline says when a connection was reused; **Settings → Reuse connections** turns it off.
- **Scripts start faster:** the sandbox prepares the next script's context while a request waits for its response, and builds the `pm` API from shared classes instead of dozens of new functions per script. With connection reuse, the benchmark's 500 requests with scripts and tests run in 0.32 s instead of 0.43 s.
- The app and the CLI load the YAML parser only when a YAML file is imported (72 fewer files at start).

## [1.3.0] - 2026-10-21

### Added
- **Payloads:** give a request the variations it should be called with: named payloads, each with variables (used anywhere in the request, such as `{{orderId}}` in the URL or body, for that call only) and optionally its own body. Each call sends the next payload in turn or a random one, in Send, the Runner and Monitors; **Send with this** sends a chosen one. Import payloads from a CSV or JSON file (one per row: `name`, `body` and variables). The response, the Runner's results and the Traffic page say which payload was sent, and Traffic adds a **By payload** table, so a slow payload (say, a large payment's fraud check) can be told from a slow instance. With round robin, every payload goes to every instance in turn, so the two are never mixed up. A Runner run starts from the first payload; Monitors keep rotating.
- **Load balancing and traffic by instance:** a discovery source keeps every instance it finds (Consul and Eureka instances, and, with the new Kubernetes **Pods** address mode, every pod behind a Service). Requests that use its variables can go to the first instance, each instance in turn (round robin) or a random one, in Send, the Runner and Monitors alike; unhealthy instances are skipped, and a value you set yourself (in the environment or a script) always wins. Each source has a **Traffic** page beside its configuration, live: requests and share, p50 and p95 response times, 2xx/4xx/5xx and connection errors, with instances that are much **slower** than their siblings or **failing** often flagged, and instances that got no requests listed too. Behind a load balancer, name the response header that says which instance answered (such as `X-Served-By`) and requests are counted by it. The Traffic report **exports** as Excel (by instance and recent requests), CSV, PDF, a PNG image, an HTML page, Markdown or JSON; instances that dropped out of the registry are marked **left the pool**. A **Recent requests** list shows each request as it happens: when it was sent, the gap in milliseconds since the previous response, the instance and its status and time. The response shows which instance answered, and a run's results add a table by instance.
- **OpenAPI documents in Service discovery, with versioned sync:** point a source at an OpenAPI (Swagger) document, JSON or YAML, and its server becomes a base URL variable (`{{lots_url}}`) while every operation becomes a request in a collection that uses it. The token the document needs is placed in the environment for the requests' auth. Each sync records the document's version and a fingerprint of its content, so an unchanged document changes nothing, and a new one is compared with the last: added, changed (query params, path variables, headers, body, auth, responses, names) and removed operations are listed before anything is written, and you apply them when you're ready. Your own work is kept: values you typed, scripts and tests, requests you added, and any field you edited that the document also changed (the report says so). A request whose operation left the document is deleted only if you never changed it. A document that changed without a new `info.version` is flagged, and each applied version goes into the source's history. "Sync when HttpDash starts" only checks such a source and tells you when a new version is waiting. A Custom JSON source pointed at an OpenAPI document now says to use this type.
- **Import from a link:** paste the URL of an OpenAPI/Swagger spec or a Postman collection in the Import dialog, with an optional Bearer token for protected specs. It's fetched with your proxy, certificates and SSL settings.
- **Show / hide on every masked field:** an eye button in each token, password and secret field (service discovery, Import from a link, request auth, team access token, certificate passphrase, the lock) shows what you typed or pasted, so a long token can be checked before it's used.

### Changed
- Runner: **Gap between requests (ms)** (was Delay) now waits before every request after the first, across iterations too; it used to skip the wait between iterations, so a one-request collection run for many iterations had no gap.
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

[Unreleased]: https://github.com/gethttpdash/httpdash/compare/v1.7.0...HEAD
[1.7.0]: https://github.com/gethttpdash/httpdash/releases/tag/v1.7.0
[1.6.0]: https://github.com/gethttpdash/httpdash/releases/tag/v1.6.0
[1.5.0]: https://github.com/gethttpdash/httpdash/releases/tag/v1.5.0
[1.4.0]: https://github.com/gethttpdash/httpdash/releases/tag/v1.4.0
[1.3.0]: https://github.com/gethttpdash/httpdash/releases/tag/v1.3.0
[1.2.0]: https://github.com/gethttpdash/httpdash/releases/tag/v1.2.0
[1.1.0]: https://github.com/gethttpdash/httpdash/releases/tag/v1.1.0
[1.0.0]: https://github.com/gethttpdash/httpdash/releases/tag/v1.0.0
