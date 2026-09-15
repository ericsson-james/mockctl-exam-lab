/* yaml.js — a dependency-free YAML subset: block mappings and sequences,
   flow [..] and {..}, quoted and plain scalars, | and > block scalars with
   chomping, comments, and multi-document files. The serializer mirrors
   kubectl's style: keys sorted, sequences at the parent's indent, strings
   double-quoted only when needed. Anchors, aliases and tags are not
   supported (kubectl never emits them). */

const YAML = (() => {
  class YamlError extends Error {}

  /* ---------- parsing ---------- */

  function stripComment(s) {
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) { if (ch === q) q = null; else if (ch === '\\' && q === '"') i++; }
      else if (ch === '"' || ch === "'") { if (i === 0 || /[\s:\-,[{]/.test(s[i - 1])) q = ch; }
      else if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
    }
    return s;
  }

  function prepare(text) {
    return text.replace(/\r/g, '').replace(/\t/g, '  ').split('\n').map((raw, n) => {
      const content = stripComment(raw).replace(/\s+$/, '');
      const indent = content.search(/\S/);
      return { raw, n: n + 1, content: indent === -1 ? '' : content.slice(indent), indent: indent === -1 ? -1 : indent, blank: indent === -1 };
    });
  }

  function nextSig(lines, i) { while (i < lines.length && lines[i].blank) i++; return i; }

  /* Returns [key, rest] or null when the line is not 'key: value'. */
  function splitKey(content) {
    let i = 0, key;
    if (content[0] === '"' || content[0] === "'") {
      const q = content[0];
      i = 1;
      while (i < content.length && content[i] !== q) { if (q === '"' && content[i] === '\\') i++; i++; }
      if (i >= content.length) return null;
      key = unquote(content.slice(0, i + 1));
      i++;
      const m = content.slice(i).match(/^\s*:(?:\s|$)/);
      if (!m) return null;
      return [key, content.slice(i + m[0].length).trim()];
    }
    if (content.startsWith('- ') || content === '-' || content.startsWith('[') || content.startsWith('{')) return null;
    const m = content.match(/^([^:]*?)\s*:(?:\s+|$)/);
    if (!m) return null;
    if (m[1] === '') return null;
    return [m[1], content.slice(m[0].length).trim()];
  }

  function isSeqLine(content) { return content === '-' || content.startsWith('- '); }

  function parseNode(lines, i, indent) {
    i = nextSig(lines, i);
    if (i >= lines.length || lines[i].indent < indent) return { value: null, next: i };
    const line = lines[i];
    if (isSeqLine(line.content)) return parseSeq(lines, i, line.indent);
    if (splitKey(line.content)) return parseMap(lines, i, line.indent);
    return { value: parseInline(line.content, line.n), next: i + 1 };
  }

  function parseMap(lines, i, indent) {
    const obj = {};
    while (true) {
      i = nextSig(lines, i);
      if (i >= lines.length) break;
      const line = lines[i];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new YamlError('line ' + line.n + ': bad indentation of a mapping entry');
      const kv = splitKey(line.content);
      if (!kv) {
        if (isSeqLine(line.content)) break;
        throw new YamlError('line ' + line.n + ': could not find expected \':\'');
      }
      const [key, rest] = kv;
      let value, next;
      if (rest === '') {
        const j = nextSig(lines, i + 1);
        if (j < lines.length && lines[j].indent > indent) ({ value, next } = parseNode(lines, j, lines[j].indent));
        else if (j < lines.length && lines[j].indent === indent && isSeqLine(lines[j].content)) ({ value, next } = parseSeq(lines, j, indent));
        else { value = null; next = i + 1; }
      } else if (/^[|>][-+]?\d?$/.test(rest)) {
        ({ value, next } = parseBlockScalar(lines, i + 1, indent, rest));
      } else {
        value = parseInline(rest, line.n); next = i + 1;
      }
      obj[key] = value;
      i = next;
    }
    return { value: obj, next: i };
  }

  function parseSeq(lines, i, indent) {
    const arr = [];
    while (true) {
      i = nextSig(lines, i);
      if (i >= lines.length) break;
      const line = lines[i];
      if (line.indent !== indent || !isSeqLine(line.content)) break;
      const item = line.content === '-' ? '' : line.content.slice(2).trim();
      let value, next;
      if (item === '') {
        const j = nextSig(lines, i + 1);
        if (j < lines.length && lines[j].indent > indent) ({ value, next } = parseNode(lines, j, lines[j].indent));
        else { value = null; next = i + 1; }
      } else if (/^[|>][-+]?\d?$/.test(item)) {
        ({ value, next } = parseBlockScalar(lines, i + 1, indent, item));
      } else if (isSeqLine(item) || splitKey(item)) {
        // '- key: v' or '- - x': re-anchor this line at indent+2 and parse as a block.
        lines[i] = Object.assign({}, line, { content: item, indent: indent + 2 });
        ({ value, next } = parseNode(lines, i, indent + 2));
      } else {
        value = parseInline(item, line.n); next = i + 1;
      }
      arr.push(value);
      i = next;
    }
    return { value: arr, next: i };
  }

  function parseBlockScalar(lines, i, parentIndent, header) {
    const folded = header[0] === '>';
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const collected = [];
    let blockIndent = -1;
    while (i < lines.length) {
      const l = lines[i];
      if (l.raw.trim() === '') { collected.push(''); i++; continue; }
      const rawIndent = l.raw.search(/\S/);
      if (rawIndent <= parentIndent) break;
      if (blockIndent === -1) blockIndent = rawIndent;
      collected.push(l.raw.slice(Math.min(blockIndent, rawIndent)));
      i++;
    }
    while (collected.length && collected[collected.length - 1] === '' && chomp !== 'keep') {
      // trailing blank lines count toward chomping, not content
      if (chomp === 'clip' || chomp === 'strip') collected.pop();
    }
    let text;
    if (folded) {
      text = '';
      for (let k = 0; k < collected.length; k++) {
        const cur = collected[k];
        if (k === 0) { text = cur; continue; }
        if (cur === '') text += '\n';
        else if (collected[k - 1] === '' || /^\s/.test(cur)) text += (collected[k - 1] === '' ? '' : '\n') + cur;
        else text += ' ' + cur;
      }
    } else {
      text = collected.join('\n');
    }
    if (chomp !== 'strip' && text.length) text += '\n';
    return { value: text, next: i };
  }

  function unquote(s) {
    if (s[0] === "'") return s.slice(1, -1).replace(/''/g, "'");
    let out = '';
    for (let i = 1; i < s.length - 1; i++) {
      const ch = s[i];
      if (ch !== '\\') { out += ch; continue; }
      const n = s[++i];
      if (n === 'n') out += '\n'; else if (n === 't') out += '\t'; else if (n === 'r') out += '\r';
      else if (n === 'u') { out += String.fromCharCode(parseInt(s.substr(i + 1, 4), 16)); i += 4; }
      else out += n;
    }
    return out;
  }

  function splitTop(s) {
    const parts = [];
    let depth = 0, q = null, cur = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) { cur += ch; if (ch === q) q = null; else if (ch === '\\' && q === '"') cur += s[++i]; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '[' || ch === '{') depth++;
      if (ch === ']' || ch === '}') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim() !== '' || parts.length) parts.push(cur);
    return parts.map(p => p.trim()).filter((p, idx, all) => !(p === '' && idx === all.length - 1));
  }

  function parseInline(s, n) {
    s = s.trim();
    if (s === '') return null;
    if (s[0] === '"' || s[0] === "'") {
      if (s[s.length - 1] !== s[0] || s.length < 2) throw new YamlError('line ' + n + ': unterminated quoted string');
      return unquote(s);
    }
    if (s[0] === '[') {
      if (s[s.length - 1] !== ']') throw new YamlError('line ' + n + ': unterminated flow sequence');
      return splitTop(s.slice(1, -1)).map(p => parseInline(p, n));
    }
    if (s[0] === '{') {
      if (s[s.length - 1] !== '}') throw new YamlError('line ' + n + ': unterminated flow mapping');
      const obj = {};
      for (const p of splitTop(s.slice(1, -1))) {
        const kv = splitKey(p) || [p.replace(/:$/, ''), ''];
        obj[kv[0].trim()] = parseInline(kv[1], n);
      }
      return obj;
    }
    if (s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
    if (s === 'true' || s === 'True' || s === 'TRUE') return true;
    if (s === 'false' || s === 'False' || s === 'FALSE') return false;
    if (/^[-+]?(0|[1-9][0-9]*)$/.test(s)) return parseInt(s, 10);
    if (/^0o?[0-7]+$/.test(s)) return parseInt(s.replace(/^0o?/, ''), 8);
    if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
    if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s) && /[.eE]/.test(s)) return parseFloat(s);
    return s;
  }

  function parseAll(text) {
    const docs = [];
    const chunks = String(text).split(/^---[ \t]*(?:#.*)?$/m);
    for (const chunk of chunks) {
      const lines = prepare(chunk.replace(/^\.\.\.[ \t]*$/m, ''));
      const first = nextSig(lines, 0);
      if (first >= lines.length) continue;
      const { value, next } = parseNode(lines, first, lines[first].indent);
      const trailing = nextSig(lines, next);
      if (trailing < lines.length) throw new YamlError('line ' + lines[trailing].n + ': unexpected content \'' + lines[trailing].content + '\'');
      docs.push(value);
    }
    return docs;
  }

  function parse(text) {
    const docs = parseAll(text);
    return docs.length ? docs[0] : null;
  }

  /* ---------- serializing ---------- */

  const RESERVED = /^(true|false|null|~|yes|no|on|off|y|n|True|False|Null|Yes|No|On|Off|TRUE|FALSE|NULL|YES|NO|ON|OFF)$/;
  function quoteIfNeeded(s) {
    if (s === '') return '""';
    if (RESERVED.test(s) || /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) || /^0x[0-9a-fA-F]+$/.test(s) ||
        /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(s) || /[\s:]$/.test(s) || /: |\s#/.test(s) ||
        /[\x00-\x08\x0b-\x1f\x7f]/.test(s) || /^(\d{4}-\d{2}-\d{2}|\d+:\d+)/.test(s)) {
      return JSON.stringify(s);
    }
    return s;
  }

  function scalar(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    return quoteIfNeeded(String(v));
  }

  function serialize(v, indent) {
    const pad = ' '.repeat(indent);
    if (Array.isArray(v)) {
      if (!v.length) return pad + '[]';
      return v.map(item => {
        if (isPlainObject(item) && Object.keys(item).length) {
          const body = serialize(item, indent + 2);
          return pad + '- ' + body.slice(indent + 2);
        }
        if (Array.isArray(item) && item.length) {
          const body = serialize(item, indent + 2);
          return pad + '- ' + body.slice(indent + 2);
        }
        if (typeof item === 'string' && item.includes('\n')) return pad + '- ' + blockString(item, indent + 2);
        return pad + '- ' + (isPlainObject(item) ? '{}' : Array.isArray(item) ? '[]' : scalar(item));
      }).join('\n');
    }
    if (isPlainObject(v)) {
      const keys = Object.keys(v).sort();
      if (!keys.length) return pad + '{}';
      return keys.map(k => {
        const val = v[k];
        const key = pad + quoteIfNeeded(k) + ':';
        if (Array.isArray(val)) return val.length ? key + '\n' + serialize(val, indent) : key + ' []';
        if (isPlainObject(val)) return Object.keys(val).length ? key + '\n' + serialize(val, indent + 2) : key + ' {}';
        if (typeof val === 'string' && val.includes('\n')) return key + ' ' + blockString(val, indent + 2);
        return key + ' ' + scalar(val);
      }).join('\n');
    }
    return pad + scalar(v);
  }

  function blockString(s, indent) {
    const pad = ' '.repeat(indent);
    const keepNl = s.endsWith('\n');
    const body = (keepNl ? s.slice(0, -1) : s).split('\n').map(l => l === '' ? '' : pad + l).join('\n');
    return (keepNl ? '|' : '|-') + '\n' + body;
  }

  function stringify(v) { return serialize(v, 0) + '\n'; }

  return { parse, parseAll, stringify, YamlError };
})();
