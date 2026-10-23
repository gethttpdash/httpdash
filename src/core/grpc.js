'use strict';

/**
 * gRPC: a service's methods from .proto files or from server reflection, and calls of every kind
 * (unary, server streaming, client streaming, bidirectional) through @grpc/grpc-js. Messages are
 * plain JSON objects, encoded and decoded with protobufjs.
 *
 * A target is "host:port", or a URL: grpcs:// and https:// mean TLS (port 443 by default),
 * grpc:// and http:// mean plaintext (port 80). tls: 'auto' (from the scheme; a bare
 * host:port is plaintext), 'on' or 'off'.
 */
const fs = require('fs');
const path = require('path');
const grpc = require('@grpc/grpc-js');
const protobuf = require('protobufjs');
require('protobufjs/ext/descriptor');
const { EventEmitter } = require('events');

const STATUS_NAMES = Object.fromEntries(Object.entries(grpc.status).filter(([, v]) => typeof v === 'number').map(([k, v]) => [v, k]));
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const TO_OBJECT = { longs: String, enums: String, bytes: String, defaults: true, arrays: true, objects: true };

function parseTarget(target, tls = 'auto') {
  const raw = String(target || '').trim();
  if (!raw) throw new Error('Enter the server address, such as localhost:50051 or grpcs://api.example.com');
  const m = /^([a-z]+):\/\/(.+)$/i.exec(raw);
  const scheme = m ? m[1].toLowerCase() : '';
  if (m && !['grpc', 'grpcs', 'http', 'https'].includes(scheme)) throw new Error(`gRPC addresses start with grpc://, grpcs://, http:// or https://, not ${scheme}://`);
  const rest = (m ? m[2] : raw).replace(/\/.*$/, '');
  const schemeTls = scheme === 'grpcs' || scheme === 'https';
  const secure = tls === 'on' ? true : tls === 'off' ? false : schemeTls;
  const hostPort = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(rest);
  if (!hostPort) throw new Error(`"${raw}" is not a host and port`);
  const host = hostPort[1].replace(/^\[|\]$/g, '');
  const port = hostPort[2] || (m ? (schemeTls ? '443' : '80') : '');
  if (!port) throw new Error(`Add the port to "${raw}", such as ${raw}:50051`);
  return { host, port, secure, address: `${hostPort[1]}:${port}` };
}

/**
 * Channel credentials for a parsed target. settings: { verifySSL, ... } as for HTTP; tlsFor(url)
 * returns { secureContext } with the client certificate and trusted CAs (certificates.js).
 */
function credentialsFor(t, { verifySSL = true, tlsFor } = {}) {
  if (!t.secure) return grpc.credentials.createInsecure();
  const verify = verifySSL === false ? { rejectUnauthorized: false, checkServerIdentity: () => undefined } : {};
  const ctx = tlsFor ? tlsFor(`https://${t.address}/`) : null;
  if (ctx && ctx.secureContext) return grpc.credentials.createFromSecureContext(ctx.secureContext, verify);
  return grpc.credentials.createSsl(null, null, null, verify);
}

const channelOptions = (userAgent) => ({
  'grpc.max_receive_message_length': MAX_MESSAGE_BYTES,
  'grpc.max_send_message_length': MAX_MESSAGE_BYTES,
  ...(userAgent ? { 'grpc.primary_user_agent': userAgent } : {}),
});

// ---- Definitions -------------------------------------------------------------------------------

/**
 * Loads .proto files. Imports are looked up next to the importing file, then in importPaths;
 * Google's well-known types (google/protobuf/*.proto) are built in.
 */
function loadProtoFiles(files, importPaths = []) {
  if (!files || !files.length) throw new Error('Add a .proto file, or use server reflection');
  const root = new protobuf.Root();
  root.resolvePath = (origin, target) => {
    if (path.isAbsolute(target) && fs.existsSync(target)) return target;
    const dirs = [origin ? path.dirname(origin) : null, ...importPaths, ...files.map((f) => path.dirname(f))].filter(Boolean);
    for (const dir of dirs) {
      const p = path.resolve(dir, target);
      if (fs.existsSync(p)) return p;
    }
    return target; // protobufjs supplies google/protobuf/*.proto itself
  };
  try {
    root.loadSync(files.map((f) => path.resolve(f)), { keepCase: true, alternateCommentMode: true });
    root.resolveAll();
  } catch (e) {
    throw new Error(`Could not read the .proto files: ${e.message.replace(/^ENOENT: no such file or directory, open /, 'not found: ')}`);
  }
  return root;
}

const REFLECTION_PROTO = `
syntax = "proto3";
message ServerReflectionRequest {
  string host = 1;
  oneof message_request { string file_by_filename = 3; string file_containing_symbol = 4; string list_services = 7; }
}
message ServerReflectionResponse {
  string valid_host = 1;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }
`;
const reflectionTypes = (() => {
  const root = protobuf.parse(REFLECTION_PROTO, { keepCase: true }).root;
  return { req: root.lookupType('ServerReflectionRequest'), res: root.lookupType('ServerReflectionResponse') };
})();
const REFLECTION_SERVICES = ['grpc.reflection.v1.ServerReflection', 'grpc.reflection.v1alpha.ServerReflection'];

/**
 * Asks the server for its services and their definitions (gRPC server reflection), trying v1 and
 * then v1alpha. opts: { target, tls, metadata: [[k, v]], deadlineMs, verifySSL, tlsFor, userAgent }.
 */
async function reflect(opts) {
  const t = parseTarget(opts.target, opts.tls);
  const client = new grpc.Client(t.address, credentialsFor(t, opts), channelOptions(opts.userAgent));
  try {
    let lastError;
    for (const service of REFLECTION_SERVICES) {
      try {
        return await reflectWith(client, service, opts);
      } catch (e) {
        lastError = e;
        if (e.code !== grpc.status.UNIMPLEMENTED) break;
      }
    }
    if (lastError && lastError.code === grpc.status.UNIMPLEMENTED) throw new Error('The server does not offer reflection. Load its .proto files instead.');
    throw lastError;
  } finally {
    client.close();
  }
}

function reflectWith(client, service, opts) {
  const { req, res } = reflectionTypes;
  const stream = client.makeBidiStreamRequest(`/${service}/ServerReflectionInfo`,
    (o) => Buffer.from(req.encode(req.fromObject(o)).finish()), (b) => res.toObject(res.decode(b), { bytes: Buffer, oneofs: true }),
    toMetadata(opts.metadata), { deadline: Date.now() + (opts.deadlineMs || 30000) });
  const waiting = [];
  let failure = null;
  stream.on('data', (msg) => { const w = waiting.shift(); if (w) w.resolve(msg); });
  stream.on('error', (e) => { failure = e; waiting.splice(0).forEach((w) => w.reject(e)); });
  const ask = (msg) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    waiting.push({ resolve, reject });
    stream.write(msg);
  });
  const files = new Map(); // name -> FileDescriptorProto
  const take = (r) => {
    if (r.error_response) throw new Error(r.error_response.error_message || `Reflection error ${r.error_response.error_code}`);
    for (const bytes of (r.file_descriptor_response && r.file_descriptor_response.file_descriptor_proto) || []) {
      const fd = protobuf.descriptor.FileDescriptorProto.decode(bytes);
      if (!files.has(fd.name)) files.set(fd.name, fd);
    }
  };
  return (async () => {
    const listed = await ask({ list_services: '' });
    if (listed.error_response) throw new Error(listed.error_response.error_message);
    const names = ((listed.list_services_response && listed.list_services_response.service) || []).map((s) => s.name).filter((n) => !REFLECTION_SERVICES.includes(n));
    for (const name of names) take(await ask({ file_containing_symbol: name }));
    // Every file the services' files import, and theirs in turn.
    for (let more = true; more;) {
      more = false;
      for (const fd of [...files.values()]) {
        for (const dep of fd.dependency || []) {
          if (files.has(dep)) continue;
          try { take(await ask({ file_by_filename: dep })); more = true; } catch { files.set(dep, null); }
        }
      }
    }
    stream.end();
    const set = { file: [...files.values()].filter(Boolean) };
    let root;
    try {
      root = protobuf.Root.fromDescriptor(set);
      restoreMaps(root, set.file);
      root.resolveAll();
    } catch (e) {
      throw new Error(`The server's definitions could not be read: ${e.message}`);
    }
    return root;
  })();
}

// protobufjs reads a map field from a descriptor as a list of its "…Entry" messages, so its JSON
// would be [{ key, value }] instead of an object. The descriptors mark those entry types; make the
// fields maps again.
const SCALARS = { 1: 'double', 2: 'float', 3: 'int64', 4: 'uint64', 5: 'int32', 6: 'fixed64', 7: 'fixed32', 8: 'bool', 9: 'string', 12: 'bytes', 13: 'uint32', 15: 'sfixed32', 16: 'sfixed64', 17: 'sint32', 18: 'sint64' };
const scalarOf = (f) => SCALARS[f.type] || (typeof f.type === 'string' ? f.type.replace(/^TYPE_/, '').toLowerCase() : null);
function restoreMaps(root, files) {
  const entries = new Map(); // ".pkg.Msg.LabelsEntry" -> its DescriptorProto
  const walk = (prefix, msgs) => {
    for (const m of msgs || []) {
      const full = `${prefix}.${m.name}`;
      if (m.options && m.options.mapEntry) entries.set(full, m);
      walk(full, m.nestedType);
    }
  };
  for (const f of files) walk(f.package ? `.${f.package}` : '', f.messageType);
  if (!entries.size) return;
  const types = [];
  const collect = (ns) => { for (const o of ns.nestedArray || []) { if (o instanceof protobuf.Type) types.push(o); if (o.nestedArray) collect(o); } };
  collect(root);
  for (const type of types) {
    for (const field of [...type.fieldsArray]) {
      if (!field.repeated) continue;
      // A type name is full (".pkg.Msg.Entry") or relative, looked up from the message outwards.
      let entry = field.type.startsWith('.') ? entries.get(field.type) : null;
      for (let ns = type; !entry && ns; ns = ns.parent) entry = entries.get(`${ns.fullName}.${field.type}`);
      if (!entry) continue;
      const key = entry.field.find((x) => x.number === 1);
      const value = entry.field.find((x) => x.number === 2);
      type.remove(field);
      type.add(new protobuf.MapField(field.name, field.id, scalarOf(key), value.typeName || scalarOf(value)));
    }
  }
}

/** The services a set of definitions describes: [{ name, methods: [{ name, path, kind, requestType, responseType, example }] }]. */
function describe(root) {
  const services = [];
  const walk = (ns) => {
    for (const obj of ns.nestedArray || []) {
      if (obj instanceof protobuf.Service) {
        if (REFLECTION_SERVICES.includes(fullName(obj))) continue;
        services.push({
          name: fullName(obj),
          methods: obj.methodsArray.map((m) => {
            m.resolve();
            return {
              name: m.name, path: `/${fullName(obj)}/${m.name}`, kind: kindOf(m),
              requestType: fullName(m.resolvedRequestType), responseType: fullName(m.resolvedResponseType),
              example: example(m.resolvedRequestType),
            };
          }),
        });
      } else if (obj.nestedArray) walk(obj);
    }
  };
  walk(root);
  return services.sort((a, b) => a.name.localeCompare(b.name));
}

const fullName = (obj) => obj.fullName.replace(/^\./, '');
const kindOf = (m) => (m.requestStream ? (m.responseStream ? 'bidi' : 'client-stream') : (m.responseStream ? 'server-stream' : 'unary'));

const SCALAR_EXAMPLE = { string: '', bool: false, bytes: '', double: 0, float: 0, int32: 0, uint32: 0, sint32: 0, fixed32: 0, sfixed32: 0, int64: '0', uint64: '0', sint64: '0', fixed64: '0', sfixed64: '0' };

/** A message filled with each field's default, nested messages included (as deep as 4 levels). */
function example(type, depth = 0, seen = new Set()) {
  const out = {};
  if (seen.has(type) || depth > 4) return out;
  seen = new Set(seen).add(type);
  for (const field of type.fieldsArray) {
    if (field.partOf && field.partOf.oneof[0] !== field.name) continue; // one field of each oneof
    field.resolve();
    const value = () => {
      const rt = field.resolvedType;
      if (rt instanceof protobuf.Type) return example(rt, depth + 1, seen);
      if (rt instanceof protobuf.Enum) return Object.keys(rt.values)[0];
      return SCALAR_EXAMPLE[field.type] !== undefined ? SCALAR_EXAMPLE[field.type] : null;
    };
    out[field.name] = field.map ? { [field.keyType === 'string' ? 'key' : '0']: value() } : field.repeated ? [value()] : value();
  }
  return out;
}

// ---- Calls -------------------------------------------------------------------------------------

function findMethod(root, service, method) {
  let svc;
  try { svc = root.lookupService(service); } catch { throw new Error(`The definitions have no service "${service}"`); }
  const m = svc.methods[method];
  if (!m) throw new Error(`The service ${service} has no method "${method}"`);
  m.resolve();
  return { svc, m, path: `/${fullName(svc)}/${m.name}`, kind: kindOf(m), req: m.resolvedRequestType, res: m.resolvedResponseType };
}

// Field names as written in the .proto, or in lowerCamelCase as proto3 JSON writes them
// ("order_id" or "orderId"). A name the message doesn't have would be dropped without a word, so
// it's an error instead.
function normalize(type, obj, where) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${where} must be a JSON object`);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const field = type.fields[k] || type.fieldsArray.find((f) => camel(f.name) === k);
    if (!field) throw new Error(`${fullName(type)} has no field "${k}"${where === 'The message' ? '' : ` (in ${where})`}`);
    field.resolve();
    const nested = field.resolvedType instanceof protobuf.Type && !field.resolvedType.fullName.startsWith('.google.protobuf.') ? field.resolvedType : null;
    const fix = (x, w) => (nested && x && typeof x === 'object' && !Array.isArray(x) ? normalize(nested, x, w) : x);
    if (field.map && v && typeof v === 'object') out[field.name] = Object.fromEntries(Object.entries(v).map(([mk, x]) => [mk, fix(x, `${k}.${mk}`)]));
    else if (Array.isArray(v)) out[field.name] = v.map((x, i) => fix(x, `${k}[${i}]`));
    else out[field.name] = fix(v, k);
  }
  return out;
}
const camel = (s) => s.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());

function encoder(type) {
  return (obj) => {
    const msg = type.fromObject(normalize(type, obj, 'The message'));
    const err = type.verify(msg);
    if (err) throw new Error(`The message doesn't fit ${fullName(type)}: ${err}`);
    return Buffer.from(type.encode(msg).finish());
  };
}
const decoder = (type) => (buf) => type.toObject(type.decode(buf), TO_OBJECT);

function toMetadata(pairs) {
  const md = new grpc.Metadata();
  for (const [k, v] of pairs || []) {
    const key = String(k || '').trim().toLowerCase();
    if (!key || /^(content-type|te|user-agent|grpc-.*|:.*)$/.test(key)) continue;
    if (key.endsWith('-bin')) md.add(key, Buffer.from(String(v), 'base64'));
    else md.add(key, String(v));
  }
  return md;
}
const fromMetadata = (md) => {
  const out = [];
  for (const [k, vs] of Object.entries(md ? md.toJSON() : {})) for (const v of vs) out.push([k, Buffer.isBuffer(v) ? v.toString('base64') : String(v)]);
  return out;
};

/**
 * A call in progress. Events: 'headers' (pairs), 'message' (object), 'sent' (object), and 'status'
 * once at the end: { code, name, details, trailers, time } (also for a connection that failed).
 * For client and bidi streaming, write() sends each message and end() says there are no more.
 */
class Call extends EventEmitter {
  constructor(kind) {
    super();
    this.kind = kind;
    this.started = Date.now();
    this.finished = false;
  }

  write(obj) {
    if (this.finished) throw new Error('The call has ended');
    if (!this.call.write) throw new Error(`A ${this.kind} call takes one message, sent when it starts`);
    this.check(obj); // grpc-js encodes later, where a bad message would only fail the call
    this.call.write(obj);
    this.emit('sent', obj);
  }

  end() { if (!this.finished && this.call.end) this.call.end(); }
  cancel() { if (!this.finished) this.call.cancel(); }

  finish(status) {
    if (this.finished) return;
    this.finished = true;
    if (this.client) this.client.close();
    this.emit('status', {
      code: status.code, name: STATUS_NAMES[status.code] || String(status.code), details: status.details || '',
      trailers: fromMetadata(status.metadata), time: Date.now() - this.started,
    });
  }
}

/**
 * Starts a call. opts: { target, tls, root, service, method, metadata: [[k, v]], deadlineMs,
 * message (the request, for unary and server-streaming calls), verifySSL, tlsFor, userAgent }.
 */
function start(opts) {
  const t = parseTarget(opts.target, opts.tls);
  const { path: methodPath, kind, req, res } = findMethod(opts.root, opts.service, opts.method);
  const ser = encoder(req);
  if (kind === 'unary' || kind === 'server-stream') ser(opts.message || {}); // a bad message fails here, before connecting
  const call = new Call(kind);
  call.check = ser;
  const client = new grpc.Client(t.address, credentialsFor(t, opts), channelOptions(opts.userAgent));
  call.client = client;
  const md = toMetadata(opts.metadata);
  const callOpts = opts.deadlineMs ? { deadline: Date.now() + opts.deadlineMs } : {};
  const des = decoder(res);
  const onStatus = (s) => call.finish(s);
  const onError = (e) => call.finish({ code: e.code != null ? e.code : grpc.status.UNKNOWN, details: e.details || e.message, metadata: e.metadata });
  let c;
  if (kind === 'unary') {
    c = client.makeUnaryRequest(methodPath, ser, des, opts.message || {}, md, callOpts, (err, msg) => { if (!err) call.emit('message', msg); });
    call.emit('sent', opts.message || {});
  } else if (kind === 'server-stream') {
    c = client.makeServerStreamRequest(methodPath, ser, des, opts.message || {}, md, callOpts);
    call.emit('sent', opts.message || {});
  } else if (kind === 'client-stream') {
    c = client.makeClientStreamRequest(methodPath, ser, des, md, callOpts, (err, msg) => { if (!err) call.emit('message', msg); });
  } else {
    c = client.makeBidiStreamRequest(methodPath, ser, des, md, callOpts);
  }
  call.call = c;
  c.on('metadata', (m) => call.emit('headers', fromMetadata(m)));
  if (kind === 'server-stream' || kind === 'bidi') c.on('data', (msg) => call.emit('message', msg));
  c.on('status', onStatus);
  c.on('error', onError);
  return call;
}

/**
 * Calls a method and waits for its end: messages (an array, for the streaming kinds) are all sent
 * first. Resolves with { status: { code, name, details }, headers, trailers, messages, time }.
 */
function invoke(opts) {
  return new Promise((resolve, reject) => {
    let call;
    try {
      const msgs = opts.messages || (opts.message ? [opts.message] : [{}]);
      call = start({ ...opts, message: msgs[0] });
      const out = { headers: [], messages: [], sent: [] };
      call.on('headers', (h) => { out.headers = h; });
      call.on('message', (m) => out.messages.push(m));
      call.on('sent', (m) => out.sent.push(m));
      call.on('status', (s) => resolve({ ...out, status: { code: s.code, name: s.name, details: s.details }, trailers: s.trailers, time: s.time }));
      if (call.kind === 'client-stream' || call.kind === 'bidi') {
        for (const m of msgs) call.write(m);
        call.end();
      }
    } catch (e) {
      if (call) call.cancel();
      reject(e);
    }
  });
}

module.exports = { parseTarget, credentialsFor, loadProtoFiles, reflect, describe, example, start, invoke, STATUS_NAMES };
