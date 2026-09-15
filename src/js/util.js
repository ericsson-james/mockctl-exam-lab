/* util.js — shared helpers. */

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Quote-aware tokenizer. Operators '|', '>', '>>', '&&', ';' become their
   own tokens (unless quoted). Returns { tokens } or { error }. */
function tokenize(str) {
  const tokens = [];
  let cur = '', inTok = false, q = null;
  const flush = () => { if (inTok) { tokens.push(cur); cur = ''; inTok = false; } };
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (q) {
      if (ch === q) { q = null; }
      else if (ch === '\\' && q === '"' && i + 1 < str.length) { cur += str[++i]; }
      else { cur += ch; }
    } else if (ch === '"' || ch === "'") {
      q = ch; inTok = true;
    } else if (ch === '\\' && i + 1 < str.length) {
      cur += str[++i]; inTok = true;
    } else if (ch === '|') {
      flush(); tokens.push('|');
    } else if (ch === '>') {
      flush();
      if (str[i + 1] === '>') { tokens.push('>>'); i++; } else tokens.push('>');
    } else if (ch === '&' && str[i + 1] === '&') {
      flush(); tokens.push('&&'); i++;
    } else if (ch === ';') {
      flush(); tokens.push(';');
    } else if (ch === ' ' || ch === '\t') {
      flush();
    } else {
      cur += ch; inTok = true;
    }
  }
  flush();
  if (q) return { error: 'unclosed quote' };
  return { tokens };
}

function pathString(parts) { return '/' + parts.join('/'); }

function splitFlags(args) {
  const flags = new Set(), rest = [];
  for (const a of args) {
    if (/^-[a-zA-Z]+$/.test(a)) for (const f of a.slice(1)) flags.add(f);
    else rest.push(a);
  }
  return { flags, rest };
}

function encodeCode(prefix, text) { return prefix + btoa(unescape(encodeURIComponent(text))); }
function decodeCode(prefix, code) {
  if (!code.startsWith(prefix)) return null;
  try { return decodeURIComponent(escape(atob(code.slice(prefix.length)))); } catch (e) { return null; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function deepClone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

/* Deep merge b into a (objects recursively; arrays and scalars replace). */
function deepMerge(a, b) {
  if (!isPlainObject(a) || !isPlainObject(b)) return deepClone(b);
  const out = Object.assign({}, a);
  for (const [k, v] of Object.entries(b)) {
    if (v === null) delete out[k];
    else out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : deepClone(v);
  }
  return out;
}
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/* Dotted path with [index] access: getPath(obj, 'spec.containers[0].image'). */
function parsePath(path) {
  const out = [];
  const segs = [];
  const p = String(path).replace(/^\./, '');
  let cur = '';
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '\\' && p[i + 1] === '.') { cur += '.'; i++; continue; }
    if (p[i] === '.') { segs.push(cur); cur = ''; continue; }
    cur += p[i];
  }
  segs.push(cur);
  for (const seg of segs) {
    if (!seg) continue;
    const m = seg.match(/^([^[\]]*)((?:\[[^\]]*\])*)$/);
    if (!m) { out.push(seg); continue; }
    if (m[1]) out.push(m[1]);
    for (const idx of m[2].match(/\[([^\]]*)\]/g) || []) out.push(idx.slice(1, -1));
  }
  return out;
}
function getPath(obj, path) {
  let cur = obj;
  for (const key of parsePath(path)) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      if (key === '*') return cur; // caller handles wildcard
      cur = cur[parseInt(key, 10)];
    } else cur = cur[key];
  }
  return cur;
}
function setPath(obj, path, value) {
  const keys = parsePath(path);
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const nextIsIndex = /^\d+$/.test(keys[i + 1]);
    if (Array.isArray(cur)) {
      const idx = parseInt(k, 10);
      if (cur[idx] === undefined || typeof cur[idx] !== 'object') cur[idx] = nextIsIndex ? [] : {};
      cur = cur[idx];
    } else {
      if (cur[k] === undefined || typeof cur[k] !== 'object' || cur[k] === null) cur[k] = nextIsIndex ? [] : {};
      cur = cur[k];
    }
  }
  const last = keys[keys.length - 1];
  if (Array.isArray(cur)) cur[parseInt(last, 10)] = value; else cur[last] = value;
}

/* Kubernetes-style relative age: 12s, 5m, 3h, 2d, 40d. */
function ageString(isoOrMs, now) {
  const t = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  let s = Math.max(0, Math.floor(((now || Date.now()) - t) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + (s % 60 && m < 10 ? (s % 60) + 's' : '');
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h' + (m % 60 && h < 10 ? (m % 60) + 'm' : '');
  const d = Math.floor(h / 24);
  if (d < 365) return d + 'd' + (h % 24 && d < 10 ? (h % 24) + 'h' : '');
  return Math.floor(d / 365) + 'y';
}

function durationString(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
}

/* Deterministic short hash (hex) for pod-template-hash and stable fake metrics. */
function shortHash(str, len) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    h1 = Math.imul(h1 ^ str.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 + str.charCodeAt(i), 2246822519) >>> 0;
  }
  return (h1.toString(16) + h2.toString(16)).slice(0, len || 9);
}
/* Random suffix using the same consonant/digit alphabet Kubernetes uses. */
function randSuffix(n) {
  const alpha = 'bcdfghjklmnpqrstvwxz2456789';
  let s = '';
  for (let i = 0; i < (n || 5); i++) s += alpha[Math.floor(Math.random() * alpha.length)];
  return s;
}
function randomUid() {
  const h = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return h() + '-' + h().slice(0, 4) + '-4' + h().slice(1, 4) + '-' + h().slice(0, 4) + '-' + h() + h().slice(0, 4);
}

/* Parse quantities like 500Mi, 1Gi, 250m, 2 into base units. */
function parseQuantity(q) {
  if (q === undefined || q === null) return NaN;
  const m = String(q).match(/^([0-9.]+)([a-zA-Z]*)$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const suffix = m[2];
  const table = { '': 1, m: 0.001, k: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
  return suffix in table ? n * table[suffix] : NaN;
}
function formatBytes(n) {
  if (n >= 1024 ** 3) return Math.round(n / 1024 ** 3) + 'Gi';
  if (n >= 1024 ** 2) return Math.round(n / 1024 ** 2) + 'Mi';
  return Math.round(n / 1024) + 'Ki';
}

/* Strategic merge (the kubectl default): like deepMerge, but lists of
   named objects (containers, volumes, env, ports...) merge by name. */
function strategicMerge(a, b) {
  if (Array.isArray(a) && Array.isArray(b) && b.every(x => isPlainObject(x)) && a.every(x => isPlainObject(x))) {
    const keyOf = (x) => x.name !== undefined ? 'name:' + x.name : x.containerPort !== undefined ? 'port:' + x.containerPort : x.mountPath !== undefined ? 'mp:' + x.mountPath : x.key !== undefined ? 'key:' + x.key : null;
    if (b.some(x => keyOf(x) === null) || a.some(x => keyOf(x) === null)) return deepClone(b);
    const out = a.map(deepClone);
    for (const item of b) {
      if (item.$patch === 'delete') { const i = out.findIndex(x => keyOf(x) === keyOf(item)); if (i !== -1) out.splice(i, 1); continue; }
      const i = out.findIndex(x => keyOf(x) === keyOf(item));
      if (i === -1) out.push(deepClone(item)); else out[i] = strategicMerge(out[i], item);
    }
    return out;
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return deepClone(b);
  const out = Object.assign({}, a);
  for (const [k, v] of Object.entries(b)) {
    if (v === null) delete out[k];
    else out[k] = (Array.isArray(out[k]) && Array.isArray(v)) || (isPlainObject(out[k]) && isPlainObject(v)) ? strategicMerge(out[k], v) : deepClone(v);
  }
  return out;
}
