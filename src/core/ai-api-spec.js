'use strict';

/**
 * The HttpDash API for AI agents (and scripts): every operation, its permission and where it runs.
 * The local server routes from this table and serves it as an OpenAPI 3.1 document, and the MCP
 * bridge (httpdash mcp) turns each operation into a tool, so the description can't drift from
 * what the API does.
 *
 * Permissions (Settings → AI access): read, run (send requests, runs, compare, sync), edit
 * (change requests and environments), ui (screenshots and acting on the screen), secrets (secret
 * values instead of masks; never on unless chosen).
 */

const id = (name, description) => ({ name, in: 'path', required: true, description, schema: { type: 'string' } });
const q = (name, type, description, extra = {}) => ({ name, in: 'query', required: false, description, schema: { type, ...extra } });
const obj = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const strings = (description) => ({ type: 'array', items: { type: 'string' }, description });

const requestDef = obj({
  method: str('HTTP method', { default: 'GET' }),
  url: str('URL; {{variables}} are allowed'),
  headers: { type: 'array', items: obj({ key: str('Name'), value: str('Value'), enabled: bool('Sent when true (default)') }, ['key']), description: 'Headers' },
  params: { type: 'array', items: obj({ key: str('Name'), value: str('Value'), enabled: bool('Sent when true (default)') }, ['key']), description: 'Query parameters (kept in step with the URL)' },
  body: obj({ mode: str('none, raw, urlencoded, formdata or graphql'), raw: str('Raw body text'), rawLanguage: str('json, text, xml, html or javascript') }),
  auth: { type: 'object', description: 'Auth settings: { type: inherit | none | bearer | basic | apikey | oauth2 | ..., <type>: {...} }' },
  description: str('Documentation for the request'),
  tags: strings('Tags'),
  preRequestScript: str('Pre-request script (pm API)'),
  testScript: str('Test script (pm API, chai)'),
  payloads: obj({
    mode: str('off, sequence or random'),
    items: { type: 'array', items: obj({ name: str('Name'), enabled: bool('Used when true (default)'), body: str('Body for this payload (empty: the request\'s body)'), variables: { type: 'array', items: obj({ key: str('Name'), value: str('Value') }, ['key']) } }), description: 'Variations each call can send' },
  }),
});

// Scripts on a collection or folder run before (pre-request) or after (test) every request inside it.
const containerScripts = {
  preRequestScript: str('Pre-request script (pm API) run before every request inside it'),
  testScript: str('Test script (pm API, chai) run after every request inside it'),
};

const OPERATIONS = [
  // ---- About the app --------------------------------------------------------------------------
  { id: 'getStatus', method: 'get', path: '/status', permission: 'read', target: 'renderer', tag: 'App',
    summary: 'What HttpDash is showing and doing now',
    description: 'Version, the active environment, open tabs and which one is active, whether a run is in progress, and what this connection is allowed to do. A good first call.' },
  { id: 'getAccessLog', method: 'get', path: '/access-log', permission: 'read', target: 'main', tag: 'App',
    summary: 'Recent calls made through this API', parameters: [q('limit', 'integer', 'How many, newest first (default 50, at most 500)')] },

  // ---- Collections and requests ---------------------------------------------------------------
  { id: 'listCollections', method: 'get', path: '/collections', permission: 'read', target: 'renderer', tag: 'Requests',
    summary: 'Collections with their folders and requests',
    description: 'A tree of every collection: folders and requests with their id, name, method, URL and tags (not their full definitions; use getRequest).' },
  { id: 'getCollection', method: 'get', path: '/collections/{collectionId}', permission: 'read', target: 'renderer', tag: 'Requests',
    summary: 'One collection: its tree, variables, auth and scripts', parameters: [id('collectionId', 'Collection id')] },
  { id: 'searchRequests', method: 'get', path: '/requests', permission: 'read', target: 'renderer', tag: 'Requests',
    summary: 'Find requests by text, tag, method or URL',
    description: 'The same search as the sidebar: every tag given must be on the request, any one of the methods will do, url and text must match. Each word of text must be found, in any order, in the name, URL, a tag, the method, or a folder or collection the request is in.',
    parameters: [q('text', 'string', 'Words to find in the name, URL, tags, method or folder names'), q('tag', 'string', 'A tag; comma-separate several'), q('method', 'string', 'GET, POST... comma-separate several'), q('url', 'string', 'Part of the URL'), q('limit', 'integer', 'At most this many (default 100)')] },
  { id: 'getRequest', method: 'get', path: '/requests/{requestId}', permission: 'read', target: 'renderer', tag: 'Requests',
    summary: 'A request\'s full definition', description: 'Method, URL, params, headers, body, auth, scripts, tags, payloads and where it sits. Secret values are masked unless the secrets permission is on.',
    parameters: [id('requestId', 'Request id')] },
  { id: 'createCollection', method: 'post', path: '/collections', permission: 'edit', target: 'renderer', tag: 'Requests',
    summary: 'Create a collection', body: obj({ name: str('Name'), description: str('Description'), variables: { type: 'object', additionalProperties: { type: 'string' }, description: 'Collection variables: { name: value }' }, ...containerScripts }, ['name']) },
  { id: 'updateCollection', method: 'patch', path: '/collections/{collectionId}', permission: 'edit', target: 'renderer', tag: 'Requests',
    summary: 'Change a collection\'s name, description or scripts (only the fields given)', parameters: [id('collectionId', 'Collection id')],
    body: obj({ name: str('New name'), description: str('Description'), ...containerScripts }) },
  { id: 'createFolder', method: 'post', path: '/collections/{collectionId}/folders', permission: 'edit', target: 'renderer', tag: 'Requests',
    summary: 'Create a folder in a collection (or inside another folder)', parameters: [id('collectionId', 'Collection id')],
    body: obj({ name: str('Name'), parentFolderId: str('Folder to create it in (optional)'), description: str('Description'), ...containerScripts }, ['name']) },
  { id: 'getFolder', method: 'get', path: '/folders/{folderId}', permission: 'read', target: 'renderer', tag: 'Requests',
    summary: 'One folder: its tree, auth and scripts', parameters: [id('folderId', 'Folder id')] },
  { id: 'updateFolder', method: 'patch', path: '/folders/{folderId}', permission: 'edit', target: 'renderer', tag: 'Requests',
    summary: 'Change a folder\'s name, description or scripts (only the fields given)', parameters: [id('folderId', 'Folder id')],
    body: obj({ name: str('New name'), description: str('Description'), ...containerScripts }) },
  { id: 'createRequest', method: 'post', path: '/requests', permission: 'edit', target: 'renderer', tag: 'Requests',
    summary: 'Add a request to a collection or folder',
    body: obj({ collectionId: str('Collection to add it to'), folderId: str('Folder inside that collection (optional)'), name: str('Name'), request: requestDef }, ['collectionId', 'name']) },
  { id: 'updateRequest', method: 'patch', path: '/requests/{requestId}', permission: 'edit', target: 'renderer', tag: 'Requests',
    summary: 'Change a request (only the fields given)', parameters: [id('requestId', 'Request id')],
    body: obj({ name: str('New name'), request: requestDef }) },
  { id: 'deleteRequest', method: 'delete', path: '/requests/{requestId}', permission: 'edit', target: 'renderer', tag: 'Requests',
    summary: 'Delete a request', parameters: [id('requestId', 'Request id')] },

  // ---- Environments ---------------------------------------------------------------------------
  { id: 'listEnvironments', method: 'get', path: '/environments', permission: 'read', target: 'renderer', tag: 'Environments',
    summary: 'Environments, and which one is active' },
  { id: 'getEnvironment', method: 'get', path: '/environments/{environmentId}', permission: 'read', target: 'renderer', tag: 'Environments',
    summary: 'An environment\'s variables (secret values masked unless allowed)', parameters: [id('environmentId', 'Environment id')] },
  { id: 'setEnvironmentVariables', method: 'patch', path: '/environments/{environmentId}/variables', permission: 'edit', target: 'renderer', tag: 'Environments',
    summary: 'Set or remove variables', parameters: [id('environmentId', 'Environment id')],
    body: obj({ set: { type: 'object', additionalProperties: { type: 'string' }, description: 'Variables to set: { name: value }' }, unset: strings('Variables to remove') }) },
  { id: 'activateEnvironment', method: 'post', path: '/environments/{environmentId}/activate', permission: 'edit', target: 'renderer', tag: 'Environments',
    summary: 'Make an environment the active one ("none" for no environment)', parameters: [id('environmentId', 'Environment id, or none')] },

  // ---- Sending --------------------------------------------------------------------------------
  { id: 'sendRequest', method: 'post', path: '/requests/{requestId}/send', permission: 'run', target: 'renderer', tag: 'Sending',
    summary: 'Send a saved request and get the response',
    description: 'Sends with the active environment (or the one given), runs its scripts and tests, and returns status, headers, body (cut at maxBodyBytes), test results, timings, the instance and payload used, and, when a health URL is set for it, what the service\'s health endpoint said before, during and after (the fields that changed). With show, the request opens in the app with its response.',
    parameters: [id('requestId', 'Request id')],
    body: obj({ environmentId: str('Environment to use instead of the active one'), payloadIndex: int('Send with this payload (0-based)'), show: bool('Open it in the app with the response'), maxBodyBytes: int('Cut the body at this size (default 100000)') }) },
  { id: 'sendAdHoc', method: 'post', path: '/send', permission: 'run', target: 'renderer', tag: 'Sending',
    summary: 'Send a request, like curl, and optionally keep it in a collection',
    description: 'Use this instead of curl. It uses the environment\'s {{variables}}, cookies, client certificates, tunnels and proxy, and is logged in HttpDash. With collection (and folder), the request runs inside it, so the collection\'s auth and auth dependency (automatic login) apply: leave auth out to inherit it. With save, a request that succeeded (2xx or 3xx, no failed tests; saveIf: always keeps any) is kept there with its response as an example and the tag "ai"; a request with the same method and URL in that folder is updated instead of duplicated, and missing folders (and the collection) are created. Saving needs the edit permission. The answer says what was saved.',
    body: obj({
      request: requestDef,
      environmentId: str('Environment to use instead of the active one'),
      collection: str('Collection to run it in (and save it to): its id or name'),
      folder: str('Folder in the collection, as a path such as "Orders/Admin"'),
      save: bool('Keep the request in the collection and folder after sending it'),
      saveIf: str('success (default: 2xx/3xx and no failed tests) or always'),
      name: str('Name for the saved request (default: the method and path)'),
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags for the saved request; "ai" is always added' },
      maxBodyBytes: int('Cut the body at this size (default 100000)'),
    }, ['request']) },
  { id: 'compareInstances', method: 'post', path: '/requests/{requestId}/compare', permission: 'run', target: 'renderer', tag: 'Sending',
    summary: 'Send a request to every instance of its service and compare the answers',
    description: 'For a URL that uses a discovered service, or a host with several addresses in DNS. Returns each instance\'s status and time and the differences (odd one out, split, varies everywhere).',
    parameters: [id('requestId', 'Request id')], body: obj({ show: bool('Show the comparison in the app') }) },
  { id: 'getHistory', method: 'get', path: '/history', permission: 'read', target: 'renderer', tag: 'Sending',
    summary: 'Recently sent requests', parameters: [q('limit', 'integer', 'How many, newest first (default 50)')] },

  // ---- Runner ---------------------------------------------------------------------------------
  { id: 'startRun', method: 'post', path: '/runs', permission: 'run', target: 'renderer', tag: 'Runner',
    summary: 'Set up the Runner and start a run',
    description: 'Opens the Runner in the app on a collection (or folder), picks the requests (all, these ids, or those with every tag given), and starts. Returns at once with the run id; follow it with getRun. One run at a time. '
      + 'With data, each row is one iteration (iterations defaults to the number of rows; more iterations start the rows over): its keys are {{variables}} in the requests and pm.iterationData in scripts. '
      + 'Only top-level keys become variables, and objects or arrays are not turned into JSON: build nested values in a pre-request script, e.g. pm.variables.set("user", JSON.stringify(pm.iterationData.get("user"))). '
      + 'Without data, a data file the user chose in the Runner stays in use (the answer says so); data: [] removes it.',
    body: obj({ collectionId: str('Collection to run'), folderId: str('Only this folder'), requestIds: strings('Only these requests'), tags: strings('Only requests with every one of these tags'), environmentId: str('Environment (default: the active one)'), iterations: int('Iterations (default 1)', { minimum: 1, maximum: 1000 }), delayMs: int('Gap between requests in milliseconds', { minimum: 0 }), stopOnFailure: bool('Stop at the first failure'), data: { type: 'array', items: { type: 'object' }, maxItems: 10000, description: 'Data rows, one object per iteration, like a CSV or JSON data file in the Runner' } }, ['collectionId']) },
  { id: 'getRun', method: 'get', path: '/runs/{runId}', permission: 'read', target: 'renderer', tag: 'Runner',
    summary: 'A run\'s progress and results', parameters: [id('runId', 'Run id from startRun'), q('results', 'string', 'none, failed (default) or all')] },
  { id: 'stopRun', method: 'post', path: '/runs/{runId}/stop', permission: 'run', target: 'renderer', tag: 'Runner',
    summary: 'Stop a run in progress', parameters: [id('runId', 'Run id')] },

  // ---- Service discovery ----------------------------------------------------------------------
  { id: 'listDiscoverySources', method: 'get', path: '/discovery', permission: 'read', target: 'renderer', tag: 'Service discovery',
    summary: 'Discovery sources, their services and instances' },
  { id: 'syncDiscoverySource', method: 'post', path: '/discovery/{sourceId}/sync', permission: 'run', target: 'renderer', tag: 'Service discovery',
    summary: 'Sync a source from its registry (an OpenAPI source is only checked unless apply is true)', parameters: [id('sourceId', 'Source id')],
    body: obj({ apply: bool('For an OpenAPI source: apply the changes found') }) },
  { id: 'getTraffic', method: 'get', path: '/discovery/{sourceId}/traffic', permission: 'read', target: 'renderer', tag: 'Service discovery',
    summary: 'Traffic by instance and by payload, with slow and failing ones flagged', parameters: [id('sourceId', 'Source id')] },

  // ---- The screen -----------------------------------------------------------------------------
  { id: 'getUiState', method: 'get', path: '/ui/state', permission: 'ui', target: 'renderer', tag: 'Screen',
    summary: 'What is on screen: tabs, the active view, the sidebar panel, open dialogs' },
  { id: 'getUiSnapshot', method: 'get', path: '/ui/snapshot', permission: 'ui', target: 'renderer', tag: 'Screen',
    summary: 'Every visible control, with a ref to act on it',
    description: 'Buttons, tabs, tree items, inputs, checkboxes, table toggles and scrollable areas currently visible, each with a ref (like "e12"), its role, label, state and position, plus the main text on screen. Refs are valid until the next snapshot. Pair with takeScreenshot to see it.',
    parameters: [q('region', 'string', 'all (default), sidebar, main, request, response, modal'), q('text', 'boolean', 'Include the visible text (default true)')] },
  { id: 'uiAction', method: 'post', path: '/ui/actions', permission: 'ui', target: 'renderer', tag: 'Screen',
    summary: 'Act on a control from the snapshot: click, expand, type, press a key, scroll, choose',
    description: 'Each action briefly outlines the element in the app so the user sees it. Returns what changed (the active tab, a new dialog...). Take a new snapshot afterwards for fresh refs.',
    body: obj({
      ref: str('A ref from getUiSnapshot'),
      action: str('click, doubleClick, focus, type, press, scroll, select, check, uncheck', { enum: ['click', 'doubleClick', 'focus', 'type', 'press', 'scroll', 'select', 'check', 'uncheck'] }),
      text: str('type: the text to type (replaces the value)'),
      key: str('press: Enter, Escape, Tab, ArrowDown, ArrowUp, Backspace...'),
      value: str('select: the option value or label'),
      by: int('scroll: pixels down (negative: up)'),
      to: str('scroll: top, bottom, or the ref of an element to bring into view'),
    }, ['ref', 'action']) },
  { id: 'openItem', method: 'post', path: '/ui/open', permission: 'ui', target: 'renderer', tag: 'Screen',
    summary: 'Open a request, collection, folder, environment, discovery source or the Runner in a tab',
    body: obj({ kind: str('request, collection, folder, environment, discovery, traffic, runner', { enum: ['request', 'collection', 'folder', 'environment', 'discovery', 'traffic', 'runner'] }), id: str('Its id (for runner: the collection id, optional)') }, ['kind']) },
  { id: 'takeScreenshot', method: 'get', path: '/ui/screenshot', permission: 'ui', target: 'main', tag: 'Screen',
    summary: 'A PNG of the window or part of it',
    parameters: [q('region', 'string', 'window (default), sidebar, main, request, response, modal'), q('ref', 'string', 'Only this element (a ref from getUiSnapshot)'),
      q('scale', 'number', 'Image pixels per screen point: 1 (default; half the size on a high-resolution display) up to 2 for full detail', { minimum: 0.25, maximum: 2 }),
      q('format', 'string', 'png (default) or base64 (JSON)')],
    response: 'image/png' },
];

// Path templates as patterns, for routing.
for (const op of OPERATIONS) {
  op.parameters = op.parameters || [];
  const names = [];
  op.pattern = new RegExp(`^${op.path.replace(/\{(\w+)\}/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
  op.pathNames = names;
}

/** Finds the operation for a method and path: { op, params } or null. */
function route(method, pathname) {
  for (const op of OPERATIONS) {
    if (op.method !== method.toLowerCase()) continue;
    const m = op.pattern.exec(pathname);
    if (m) return { op, params: Object.fromEntries(op.pathNames.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

const ERROR = { description: 'Error', content: { 'application/json': { schema: obj({ error: str('What went wrong') }) } } };

/** The OpenAPI 3.1 document for the API on this port. */
function openApiDocument({ version = '0.0.0', port } = {}) {
  const paths = {};
  for (const op of OPERATIONS) {
    const item = (paths[op.path] = paths[op.path] || {});
    item[op.method] = {
      operationId: op.id,
      tags: [op.tag],
      summary: op.summary,
      ...(op.description ? { description: op.description } : {}),
      'x-permission': op.permission,
      ...(op.parameters.length ? { parameters: op.parameters } : {}),
      ...(op.body ? { requestBody: { required: true, content: { 'application/json': { schema: op.body } } } } : {}),
      responses: {
        200: op.response === 'image/png'
          ? { description: 'The screenshot', content: { 'image/png': { schema: { type: 'string', format: 'binary' } }, 'application/json': { schema: obj({ base64: str('PNG, base64'), width: int('Pixels'), height: int('Pixels') }) } } }
          : { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } },
        401: ERROR, 403: ERROR, 404: ERROR, 409: ERROR, 423: ERROR,
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'HttpDash',
      version,
      description: [
        'Control HttpDash, the API client, running on this computer: read collections, requests and environments; send requests and see responses;',
        'set up and run the Runner and read results; compare instances of a service; check service discovery traffic; and see and act on the screen',
        '(snapshot of visible controls with refs, actions on them, screenshots). Every call needs the token from Settings → AI access, as',
        '"Authorization: Bearer <token>". Each operation lists the permission it needs (x-permission): read, run, edit or ui; the user chooses',
        'which are allowed. Every call is shown to the user in the app.',
      ].join(' '),
    },
    servers: [{ url: `http://127.0.0.1:${port || 47823}`, description: 'HttpDash on this computer' }],
    security: [{ token: [] }],
    components: { securitySchemes: { token: { type: 'http', scheme: 'bearer', description: 'The token from Settings → AI access' } } },
    tags: [...new Set(OPERATIONS.map((o) => o.tag))].map((name) => ({ name })),
    paths,
  };
}

module.exports = { OPERATIONS, route, openApiDocument, PERMISSIONS: ['read', 'run', 'edit', 'ui', 'secrets'] };
