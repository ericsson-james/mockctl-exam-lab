/* vim.js — a modal editor good enough for exam YAML.
   Modes: normal, insert, visual (v), visual line (V), command (:), search (/ ?).
   Motions: h j k l w b e 0 ^ $ gg G f t F T ; , % { } H M L + - and the arrow keys,
   with counts. Operators d y c > < combine with any motion, with dd/yy/cc/>>/<<
   for lines, and with text objects (iw aw iW aW i" a" i' a' i( a( i[ a[ i{ a{).
   Visual mode: d x y c s > < J ~ u U p o, and : prefilled with '<,'>.
   Edits: x X r s S C D J ~ o O i I a A p P u Ctrl-R and . (repeat last change).
   Commands: :w :q :wq :x :q! :N :$ :[range]d :[range]y :[range]s/a/b/g :g/re/d
   :v/re/d :[range]sort :set nu :noh. Paste (Cmd/Ctrl+V, Shift+Insert) inserts at
   the cursor in any mode; autoindent on Enter; Tab is two spaces.
   open() returns a promise resolved on quit. */

const VIM_WORD = /^(\w+|[^\w\s]+)/;
const VIM_PAIRS = { '(': ')', '[': ']', '{': '}', '<': '>' };
const VIM_CLOSERS = { ')': '(', ']': '[', '}': '{', '>': '<' };

class Editor {
  constructor(app) {
    this.app = app;
    this.el = document.getElementById('vim');
    this.textEl = document.getElementById('vimText');
    this.leftEl = document.getElementById('vimLeft');
    this.rightEl = document.getElementById('vimRight');
    this.cmdEl = document.getElementById('vimCmd');
    this.v = null;
    document.addEventListener('keydown', (e) => this.onKey(e));
  }

  open({ text = '', name = '[No Name]', validate = null, onSave = null, onInvalid = null }) {
    return new Promise((resolve) => {
      this.v = {
        lines: text.length ? text.replace(/\n$/, '').split('\n') : [''],
        r: 0, c: 0, mode: 'normal', cmdline: '', pending: '', count: '', opCount: 0,
        name, validate, onSave, onInvalid, resolve, errorBlock: 0, hadErrors: false,
        modified: false, everSaved: false, savedText: text,
        undo: [], redo: [], reg: null, regLinewise: false,
        search: null, searchDir: 1, showNumbers: false, message: '"' + name + '" ' + (text.length ? text.replace(/\n$/, '').split('\n').length + 'L, ' + text.length + 'B' : '[New File]'), msgErr: false,
        va: null, lastSel: null, lastFind: null,
        rec: [], recActive: false, recUndo: 0, lastChange: null, replaying: false,
      };
      this.app.term.suspended = true;
      this.app.term.cmdEl.blur();
      this.el.hidden = false;
      this.render();
    });
  }

  close(saved) {
    const v = this.v;
    this.v = null;
    this.el.hidden = true;
    this.app.term.suspended = false;
    this.app.term.focus();
    v.resolve({ saved, text: v.lines.join('\n') + '\n', hadErrors: v.hadErrors });
  }

  /* ---------- helpers ---------- */
  snapshot() { const v = this.v; v.undo.push({ lines: v.lines.slice(), r: v.r, c: v.c }); if (v.undo.length > 200) v.undo.shift(); v.redo = []; }
  clamp() {
    const v = this.v;
    if (v.r < 0) v.r = 0;
    if (v.r > v.lines.length - 1) v.r = v.lines.length - 1;
    const max = Math.max(0, v.lines[v.r].length - (v.mode === 'insert' ? 0 : 1));
    if (v.c > max) v.c = max;
    if (v.c < 0) v.c = 0;
  }
  setMsg(m, err) { this.v.message = m; this.v.msgErr = !!err; }
  text() { return this.v.lines.join('\n') + '\n'; }
  indentOf(line) { return (line.match(/^\s*/) || [''])[0]; }
  firstNonBlank(r) { return this.indentOf(this.v.lines[r]).length; }

  save(newName) {
    const v = this.v;
    const content = this.text();
    if (v.validate) { const err = v.validate(content); if (err) { this.setMsg(err.split('\n')[0], true); this.annotateError(err); return false; } }
    if (v.onSave) { const err = v.onSave(content, newName); if (err) { this.setMsg(err, true); return false; } }
    if (newName) v.name = newName;
    v.modified = false; v.everSaved = true; v.savedText = content;
    this.setMsg('"' + v.name + '" ' + v.lines.length + 'L, ' + content.length + 'B written');
    return true;
  }

  /* kubectl re-opens a rejected edit with the failure as comment lines at the
     top of the file. Do the same in place: replace any previous failure block,
     put the cursor on it, and leave the learner's edits untouched below. */
  annotateError(err) {
    const v = this.v;
    if (!v.onInvalid) return;
    const block = v.onInvalid(err);
    if (!block || !block.length) return;
    this.snapshot();
    v.lines.splice(0, v.errorBlock, ...block);
    v.errorBlock = block.length;
    v.hadErrors = true;
    v.modified = true;
    v.r = 0; v.c = 0;
  }

  /* ---------- ranges for : commands ---------- */
  parseRange(spec) {
    const v = this.v;
    if (!spec) return null;
    const last = v.lines.length - 1;
    const one = (t) => {
      t = t.trim();
      if (t === '.') return v.r;
      if (t === '$') return last;
      if (t === "'<") return v.lastSel ? v.lastSel.r1 : v.r;
      if (t === "'>") return v.lastSel ? v.lastSel.r2 : v.r;
      let m = t.match(/^(\.|\$)?([+-]\d+)$/);
      if (m) return Math.max(0, Math.min(last, (m[1] === '$' ? last : v.r) + parseInt(m[2], 10)));
      if (/^\d+$/.test(t)) return Math.max(0, Math.min(last, parseInt(t, 10) - 1));
      return null;
    };
    if (spec === '%') return { from: 0, to: last };
    const parts = spec.split(',');
    if (parts.length > 2) return null;
    const from = one(parts[0]);
    const to = parts.length === 2 ? one(parts[1]) : from;
    if (from === null || to === null) return null;
    return { from: Math.min(from, to), to: Math.max(from, to) };
  }

  execCmd(raw) {
    const v = this.v;
    const m = raw.trim();
    if (m === '') return;
    if (m === 'w') { this.save(); return; }
    if (m.startsWith('w ')) { this.save(m.slice(2).trim()); return; }
    if (m === 'q') { if (v.modified) return this.setMsg('E37: No write since last change (add ! to override)', true); return this.close(v.everSaved); }
    if (m === 'q!' || m === 'qa!' || m === 'qa') { if (m === 'qa' && v.modified) return this.setMsg('E37: No write since last change (add ! to override)', true); return this.close(v.everSaved); }
    if (m === 'wq' || m === 'x' || m === 'wq!' || m === 'x!' || m === 'wqa' || m === 'xa') { if (this.save()) this.close(true); return; }
    if (/^\d+$/.test(m)) { v.r = Math.min(v.lines.length, parseInt(m, 10)) - 1; v.c = this.firstNonBlank(v.r); this.clamp(); return; }
    if (m === '$') { v.r = v.lines.length - 1; v.c = this.firstNonBlank(v.r); this.clamp(); return; }
    if (m === 'set nu' || m === 'set number') { v.showNumbers = true; return; }
    if (m === 'set nonu' || m === 'set nonumber') { v.showNumbers = false; return; }
    if (m.startsWith('set ') || m === 'syntax on' || m === 'syntax off' || m.startsWith('syntax ') || m.startsWith('colorscheme')) return;
    if (m === 'noh' || m === 'nohlsearch') { v.search = null; return; }
    if (m === 'help' || m === 'h') { this.setMsg('mockctl vim: modes normal/insert/visual (v V), operators d y c > < with motions and text objects, . repeats, :[range]d|y|s|sort, :g/re/d, :%s/a/b/g, :w :q :wq'); return; }
    // :g/re/d and :v/re/d
    let g = m.match(/^(g|v|g!)\/((?:\\\/|[^/])+)\/(d|delete)?$/);
    if (g) {
      let re;
      try { re = new RegExp(g[2].replace(/\\\//g, '/')); } catch (e) { return this.setMsg('E486: Pattern not found: ' + g[2], true); }
      const invert = g[1] !== 'g';
      const keep = v.lines.filter(l => re.test(l) === invert);
      const removed = v.lines.length - keep.length;
      if (!removed) return this.setMsg(invert ? 'E486: Pattern not found' : 'E486: Pattern not found: ' + g[2], true);
      this.snapshot();
      v.reg = v.lines.filter(l => re.test(l) !== invert).join('\n'); v.regLinewise = true;
      v.lines = keep.length ? keep : [''];
      v.modified = true; this.clamp();
      if (removed > 2) this.setMsg(removed + ' fewer lines');
      return;
    }
    // [range]command
    const rc = m.match(/^([%.$'<>\d,+-]*)\s*(d|delete|y|yank|>|<|sort|sort u|s\/.*)$/);
    if (rc) {
      const range = rc[1] ? this.parseRange(rc[1]) : { from: v.r, to: v.r };
      if (!range) return this.setMsg('E16: Invalid range', true);
      const cmd = rc[2];
      if (cmd.startsWith('s/')) return this.substitute(cmd, range);
      if (cmd === 'd' || cmd === 'delete') { this.applyOperator('d', { linewise: true, r1: range.from, r2: range.to }); const n = range.to - range.from + 1; if (n > 2) this.setMsg(n + ' fewer lines'); return; }
      if (cmd === 'y' || cmd === 'yank') { this.applyOperator('y', { linewise: true, r1: range.from, r2: range.to }); return; }
      if (cmd === '>' || cmd === '<') { this.applyOperator(cmd, { linewise: true, r1: range.from, r2: range.to }, 1); return; }
      if (cmd.startsWith('sort')) {
        this.snapshot();
        let seg = v.lines.slice(range.from, range.to + 1).sort((a, b) => a.localeCompare(b));
        if (cmd === 'sort u') seg = seg.filter((l, i) => i === 0 || l !== seg[i - 1]);
        v.lines.splice(range.from, range.to - range.from + 1, ...seg);
        v.modified = true; this.clamp(); return;
      }
    }
    this.setMsg('E492: Not an editor command: ' + m, true);
  }

  substitute(cmd, range) {
    const v = this.v;
    const sub = cmd.match(/^s\/((?:\\\/|[^/])*)\/((?:\\\/|[^/])*)\/?([gi]*)$/);
    if (!sub) return this.setMsg('E486: Pattern not found', true);
    let re;
    try { re = new RegExp(sub[1].replace(/\\\//g, '/'), (sub[3].includes('g') ? 'g' : '') + (sub[3].includes('i') ? 'i' : '')); } catch (e) { return this.setMsg('E486: Pattern not found: ' + sub[1], true); }
    this.snapshot();
    let n = 0, lines = 0;
    for (let i = range.from; i <= range.to && i < v.lines.length; i++) {
      const before = v.lines[i];
      const after = before.replace(re, sub[2].replace(/\\\//g, '/'));
      if (after !== before) { n += (before.match(new RegExp(re.source, 'g' + (re.flags.includes('i') ? 'i' : ''))) || []).length; v.lines[i] = after; lines++; v.r = i; }
    }
    if (n) { v.modified = true; if (n > 1 || lines > 1) this.setMsg(n + ' substitution' + (n > 1 ? 's' : '') + ' on ' + lines + ' line' + (lines > 1 ? 's' : '')); else this.setMsg(''); }
    else { v.undo.pop(); this.setMsg('E486: Pattern not found: ' + sub[1], true); }
    this.clamp();
  }

  doSearch(dir) {
    const v = this.v;
    if (!v.search) return this.setMsg('E35: No previous regular expression', true);
    let re;
    try { re = new RegExp(v.search, 'g'); } catch (e) { return this.setMsg('E486: Pattern not found: ' + v.search, true); }
    const n = v.lines.length;
    for (let step = 0; step <= n; step++) {
      const i = ((v.r + dir * step) % n + n) % n;
      const line = v.lines[i];
      const matches = [...line.matchAll(re)].map(x => x.index).filter((x, k, arr) => arr.indexOf(x) === k);
      if (!matches.length) continue;
      const cands = step === 0 ? matches.filter(x => dir > 0 ? x > v.c : x < v.c) : (dir > 0 ? matches : matches.slice().reverse());
      if (cands.length) { v.r = i; v.c = dir > 0 ? cands[0] : Math.max(...cands); if (step === n && dir > 0) this.setMsg('search hit BOTTOM, continuing at TOP'); this.clamp(); return; }
    }
    this.setMsg('E486: Pattern not found: ' + v.search, true);
  }

  /* ---------- motions (pure: return a target, never move) ---------- */
  wordForward(r, c) {
    const L = this.v.lines;
    const line = L[r];
    const rest = line.slice(c);
    const m = rest.match(/^(\w+|[^\w\s]+)?\s*/);
    const nc = c + (m ? m[0].length : 0);
    if (nc >= line.length) {
      if (r < L.length - 1) { let nr = r + 1; while (nr < L.length - 1 && !L[nr].trim()) nr++; return { r: nr, c: this.indentOf(L[nr]).length }; }
      return { r, c: line.length };
    }
    return { r, c: nc };
  }
  wordBack(r, c) {
    const L = this.v.lines;
    if (c === 0) { if (r === 0) return { r, c }; let pr = r - 1; while (pr > 0 && !L[pr].trim()) pr--; const line = L[pr]; const m = line.match(/(\w+|[^\w\s]+)\s*$/); return { r: pr, c: m ? line.length - m[0].length : 0 }; }
    const before = this.v.lines[r].slice(0, c);
    const m = before.match(/(\w+|[^\w\s]+)\s*$/);
    return { r, c: m ? before.length - m[0].length : 0 };
  }
  wordEnd(r, c) {
    const L = this.v.lines;
    let rr = r, cc = c + 1;
    for (let guard = 0; guard < 10000; guard++) {
      const line = L[rr];
      if (cc >= line.length) { if (rr >= L.length - 1) return { r: rr, c: Math.max(0, line.length - 1) }; rr++; cc = 0; continue; }
      const rest = line.slice(cc);
      const ws = rest.match(/^\s+/);
      if (ws) { cc += ws[0].length; continue; }
      const m = rest.match(VIM_WORD);
      return { r: rr, c: cc + m[0].length - 1 };
    }
    return { r, c };
  }
  findChar(kind, ch, count) {
    const v = this.v, line = v.lines[v.r];
    let c = v.c;
    for (let i = 0; i < count; i++) {
      if (kind === 'f' || kind === 't') { const idx = line.indexOf(ch, c + 1 + (kind === 't' && i === 0 ? 1 : 0)); if (idx === -1) return null; c = idx; }
      else { const idx = line.lastIndexOf(ch, c - 1 - (kind === 'T' && i === 0 ? 1 : 0)); if (idx === -1) return null; c = idx; }
    }
    return kind === 't' ? c - 1 : kind === 'T' ? c + 1 : c;
  }
  matchBracket(r, c) {
    const L = this.v.lines;
    const line = L[r];
    let sc = c;
    while (sc < line.length && !(line[sc] in VIM_PAIRS) && !(line[sc] in VIM_CLOSERS)) sc++;
    if (sc >= line.length) return null;
    const ch = line[sc];
    const open = ch in VIM_PAIRS ? ch : VIM_CLOSERS[ch], close = VIM_PAIRS[open];
    const dir = ch in VIM_PAIRS ? 1 : -1;
    let depth = 0, rr = r, cc = sc;
    for (let guard = 0; guard < 200000; guard++) {
      const x = L[rr][cc];
      if (x === open) depth += dir === 1 ? 1 : -1;
      if (x === close) depth += dir === 1 ? -1 : 1;
      if (depth === 0) return { r: rr, c: cc };
      cc += dir;
      while (cc < 0 || cc >= L[rr].length) { rr += dir; if (rr < 0 || rr >= L.length) return null; cc = dir === 1 ? 0 : L[rr].length - 1; if (cc < 0) cc = dir === 1 ? 0 : -1; if (L[rr].length === 0) { cc = dir === 1 ? L[rr].length : -1; } }
    }
    return null;
  }
  viewportRows() {
    const el = this.textEl;
    const lineH = Math.max(1, (el.scrollHeight || 20) / Math.max(1, this.v.lines.length + 1));
    const top = Math.floor((el.scrollTop || 0) / lineH);
    const rows = Math.max(1, Math.floor((el.clientHeight || 400) / lineH));
    return { top: Math.min(top, this.v.lines.length - 1), bottom: Math.min(this.v.lines.length - 1, top + rows - 1) };
  }
  /* {r, c, linewise, inclusive} for a motion key, or null when k is not a motion */
  motion(k, count, hasCount, e, arg) {
    const v = this.v, L = v.lines, r = v.r, c = v.c;
    const ex = (t) => Object.assign({ linewise: false, inclusive: false }, t);
    switch (k) {
      case 'h': case 'ArrowLeft': case 'Backspace': return ex({ r, c: Math.max(0, c - count) });
      case 'l': case 'ArrowRight': case ' ': return ex({ r, c: Math.min(L[r].length, c + count) });
      case 'j': case 'ArrowDown': case 'Enter': case '+': return { r: Math.min(L.length - 1, r + count), c: k === '+' || k === 'Enter' ? this.firstNonBlank(Math.min(L.length - 1, r + count)) : c, linewise: true };
      case 'k': case 'ArrowUp': case '-': return { r: Math.max(0, r - count), c: k === '-' ? this.firstNonBlank(Math.max(0, r - count)) : c, linewise: true };
      case '0': case 'Home': return ex({ r, c: 0 });
      case '^': return ex({ r, c: this.firstNonBlank(r) });
      case '$': case 'End': { const rr = Math.min(L.length - 1, r + count - 1); return ex({ r: rr, c: Math.max(0, L[rr].length - 1), inclusive: true }); }
      case 'w': case 'W': { let p = { r, c }; for (let i = 0; i < count; i++) p = this.wordForward(p.r, p.c); return ex(p); }
      case 'b': case 'B': { let p = { r, c }; for (let i = 0; i < count; i++) p = this.wordBack(p.r, p.c); return ex(p); }
      case 'e': case 'E': { let p = { r, c }; for (let i = 0; i < count; i++) p = this.wordEnd(p.r, p.c); return ex(Object.assign(p, { inclusive: true })); }
      case 'G': { const rr = hasCount ? Math.min(L.length, count) - 1 : L.length - 1; return { r: rr, c: this.firstNonBlank(rr), linewise: true }; }
      case 'gg': { const rr = hasCount ? Math.min(L.length, count) - 1 : 0; return { r: rr, c: this.firstNonBlank(rr), linewise: true }; }
      case 'f': case 't': case 'F': case 'T': { const cc = this.findChar(k, arg, count); if (cc === null) return null; v.lastFind = { kind: k, ch: arg }; return ex({ r, c: cc, inclusive: k === 'f' || k === 't' }); }
      case ';': case ',': { if (!v.lastFind) return null; let kind = v.lastFind.kind; if (k === ',') kind = { f: 'F', F: 'f', t: 'T', T: 't' }[kind]; const cc = this.findChar(kind, v.lastFind.ch, count); if (cc === null) return null; return ex({ r, c: cc, inclusive: kind === 'f' || kind === 't' }); }
      case '%': { const p = this.matchBracket(r, c); return p ? ex(Object.assign(p, { inclusive: true })) : null; }
      case '{': { let rr = r; for (let i = 0; i < count; i++) { rr--; while (rr > 0 && L[rr].trim()) rr--; } return ex({ r: Math.max(0, rr), c: 0 }); }
      case '}': { let rr = r; for (let i = 0; i < count; i++) { rr++; while (rr < L.length - 1 && L[rr].trim()) rr++; } rr = Math.min(L.length - 1, rr); return ex({ r: rr, c: rr === L.length - 1 ? Math.max(0, L[rr].length - 1) : 0 }); }
      case 'H': { const vp = this.viewportRows(); const rr = Math.min(vp.bottom, vp.top + count - 1); return { r: rr, c: this.firstNonBlank(rr), linewise: true }; }
      case 'L': { const vp = this.viewportRows(); const rr = Math.max(vp.top, vp.bottom - count + 1); return { r: rr, c: this.firstNonBlank(rr), linewise: true }; }
      case 'M': { const vp = this.viewportRows(); const rr = Math.floor((vp.top + vp.bottom) / 2); return { r: rr, c: this.firstNonBlank(rr), linewise: true }; }
      case 'PageDown': return { r: Math.min(L.length - 1, r + 20 * count), c, linewise: true };
      case 'PageUp': return { r: Math.max(0, r - 20 * count), c, linewise: true };
      default:
        if (e && e.ctrlKey) {
          if (k === 'd') return { r: Math.min(L.length - 1, r + 10 * count), c, linewise: true };
          if (k === 'u') return { r: Math.max(0, r - 10 * count), c, linewise: true };
          if (k === 'f') return { r: Math.min(L.length - 1, r + 20 * count), c, linewise: true };
          if (k === 'b') return { r: Math.max(0, r - 20 * count), c, linewise: true };
        }
        return null;
    }
  }

  /* text objects -> {r1, c1, r2, c2} with c2 exclusive, or null */
  textObject(kind, ch) {
    const v = this.v, L = v.lines, r = v.r, c = v.c, line = L[r];
    if (ch === 'w' || ch === 'W') {
      if (!line.length) return null;
      const cls = ch === 'W' ? (x) => (/\s/.test(x) ? 0 : 1) : (x) => (/\w/.test(x) ? 1 : /\s/.test(x) ? 0 : 2);
      const k = cls(line[c] || ' ');
      let a = c, b = c;
      while (a > 0 && cls(line[a - 1]) === k) a--;
      while (b < line.length - 1 && cls(line[b + 1]) === k) b++;
      let c2 = b + 1;
      if (kind === 'a') {
        if (k !== 0) { let t = c2; while (t < line.length && /\s/.test(line[t])) t++; if (t > c2) c2 = t; else { let s = a; while (s > 0 && /\s/.test(line[s - 1])) s--; a = s; } }
        else { let t = c2; if (t < line.length) { const k2 = cls(line[t]); while (t < line.length && cls(line[t]) === k2) t++; c2 = t; } }
      }
      return { r1: r, c1: a, r2: r, c2 };
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const idx = []; for (let i = 0; i < line.length; i++) if (line[i] === ch && line[i - 1] !== '\\') idx.push(i);
      if (idx.length < 2) return null;
      let a = -1, b = -1;
      for (let i = 0; i + 1 < idx.length; i += 2) { if (idx[i] <= c && c <= idx[i + 1]) { a = idx[i]; b = idx[i + 1]; break; } }
      if (a === -1) { const after = idx.find(x => x > c); if (after === undefined) return null; const i = idx.indexOf(after); if (i + 1 >= idx.length) return null; a = idx[i]; b = idx[i + 1]; }
      return kind === 'a' ? { r1: r, c1: a, r2: r, c2: b + 1 } : { r1: r, c1: a + 1, r2: r, c2: b };
    }
    const open = { '(': '(', ')': '(', b: '(', '[': '[', ']': '[', '{': '{', '}': '{', B: '{', '<': '<', '>': '<' }[ch];
    if (!open) return null;
    const close = VIM_PAIRS[open];
    // find the enclosing open bracket (cursor may sit on either bracket)
    let rr = r, cc = c, depth = 0, found = null;
    if (line[c] === open) found = { r, c };
    else if (line[c] === close) { const p = this.matchBracket(r, c); found = p; }
    else {
      for (let guard = 0; guard < 200000 && !found; guard++) {
        cc--;
        while (cc < 0) { rr--; if (rr < 0) break; cc = L[rr].length - 1; }
        if (rr < 0) break;
        const x = L[rr][cc];
        if (x === close) depth++;
        else if (x === open) { if (depth === 0) found = { r: rr, c: cc }; else depth--; }
      }
    }
    if (!found) return null;
    const end = this.matchBracket(found.r, found.c);
    if (!end) return null;
    if (kind === 'a') return { r1: found.r, c1: found.c, r2: end.r, c2: end.c + 1 };
    let r1 = found.r, c1 = found.c + 1, r2 = end.r, c2 = end.c;
    if (r1 !== r2 && c1 >= L[r1].length && L[r2].slice(0, c2).trim() === '') { r1++; c1 = 0; r2--; c2 = L[r2].length; if (r2 < r1) return { r1: found.r, c1: found.c + 1, r2: found.r, c2: found.c + 1 }; return { r1, c1, r2, c2, linewise: true }; }
    return { r1, c1, r2, c2 };
  }

  /* ---------- range editing ---------- */
  getText(r1, c1, r2, c2) {
    const L = this.v.lines;
    if (r1 === r2) return L[r1].slice(c1, c2);
    return L[r1].slice(c1) + '\n' + L.slice(r1 + 1, r2).map(l => l).join(L.slice(r1 + 1, r2).length ? '\n' : '') + (r2 - r1 > 1 ? '\n' : '') + L[r2].slice(0, c2);
  }
  deleteRange(r1, c1, r2, c2) {
    const L = this.v.lines;
    if (r1 === r2) L[r1] = L[r1].slice(0, c1) + L[r1].slice(c2);
    else L.splice(r1, r2 - r1 + 1, L[r1].slice(0, c1) + L[r2].slice(c2));
  }
  /* op: d y c > < ~ u U J ; range: {linewise, r1, r2} or {linewise:false, r1, c1, r2, c2 (exclusive)} */
  applyOperator(op, range, times = 1) {
    const v = this.v, L = v.lines;
    let { r1, r2 } = range;
    if (r1 > r2) [r1, r2] = [r2, r1];
    r1 = Math.max(0, r1); r2 = Math.min(L.length - 1, r2);
    const linewise = !!range.linewise;
    // Move to the start of the range before any snapshot, so undo returns the cursor
    // to the first changed line the way vim does.
    if (op !== 'y') { v.r = r1; v.c = linewise ? this.firstNonBlank(r1) : (range.r1 < range.r2 || (range.r1 === range.r2 && range.c1 <= range.c2) ? range.c1 : range.c2); }
    if (op === 'y') {
      if (linewise) { v.reg = L.slice(r1, r2 + 1).join('\n'); v.regLinewise = true; if (r2 - r1 + 1 > 2) this.setMsg((r2 - r1 + 1) + ' lines yanked'); }
      else { v.reg = this.getText(range.r1, range.c1, range.r2, range.c2); v.regLinewise = false; }
      v.r = r1; if (!linewise) v.c = Math.min(range.c1, range.c2); this.clamp(); return;
    }
    if (op === '>' || op === '<') {
      this.snapshot();
      for (let i = r1; i <= r2; i++) for (let t = 0; t < times; t++) L[i] = op === '>' ? (L[i].length ? '  ' + L[i] : L[i]) : L[i].replace(/^ {1,2}/, '');
      v.modified = true; v.r = r1; v.c = this.firstNonBlank(r1); this.clamp();
      if (r2 - r1 + 1 > 2) this.setMsg((r2 - r1 + 1) + ' lines ' + op + 'ed ' + times + ' time' + (times > 1 ? 's' : ''));
      return;
    }
    if (op === '~' || op === 'u' || op === 'U') {
      this.snapshot();
      const f = op === '~' ? (s) => s.replace(/[a-zA-Z]/g, x => (x === x.toUpperCase() ? x.toLowerCase() : x.toUpperCase())) : op === 'u' ? (s) => s.toLowerCase() : (s) => s.toUpperCase();
      if (linewise) for (let i = r1; i <= r2; i++) L[i] = f(L[i]);
      else if (range.r1 === range.r2) L[r1] = L[r1].slice(0, range.c1) + f(L[r1].slice(range.c1, range.c2)) + L[r1].slice(range.c2);
      else { L[range.r1] = L[range.r1].slice(0, range.c1) + f(L[range.r1].slice(range.c1)); for (let i = range.r1 + 1; i < range.r2; i++) L[i] = f(L[i]); L[range.r2] = f(L[range.r2].slice(0, range.c2)) + L[range.r2].slice(range.c2); }
      v.modified = true; v.r = r1; if (!linewise) v.c = range.c1; this.clamp(); return;
    }
    if (op === 'J') {
      this.snapshot();
      const to = Math.max(r2, r1 + 1);
      for (let i = r1; i < to && r1 < L.length - 1; i++) { const next = L[r1 + 1].replace(/^\s+/, ''); v.c = L[r1].length; L[r1] = L[r1] + (next ? ' ' + next : ''); L.splice(r1 + 1, 1); }
      v.modified = true; v.r = r1; this.clamp(); return;
    }
    if (op === 'd' || op === 'c') {
      this.snapshot();
      if (linewise) {
        v.reg = L.slice(r1, r2 + 1).join('\n'); v.regLinewise = true;
        if (op === 'c') { const ind = this.indentOf(L[r1]); L.splice(r1, r2 - r1 + 1, ind); v.r = r1; v.c = ind.length; v.mode = 'insert'; }
        else { L.splice(r1, r2 - r1 + 1); if (!L.length) L.push(''); v.r = Math.min(r1, L.length - 1); v.c = this.firstNonBlank(v.r); if (r2 - r1 + 1 > 2) this.setMsg((r2 - r1 + 1) + ' fewer lines'); }
      } else {
        let { c1, c2 } = range; let a = { r: range.r1, c: c1 }, b = { r: range.r2, c: c2 };
        if (a.r > b.r || (a.r === b.r && a.c > b.c)) [a, b] = [b, a];
        v.reg = this.getText(a.r, a.c, b.r, b.c); v.regLinewise = false;
        this.deleteRange(a.r, a.c, b.r, b.c);
        v.r = a.r; v.c = a.c;
        if (op === 'c') v.mode = 'insert';
      }
      v.modified = true; this.clamp(); return;
    }
  }

  /* operator + motion: build the range vim would use */
  rangeToTarget(t, inclusive) {
    const v = this.v;
    if (t.linewise) return { linewise: true, r1: Math.min(v.r, t.r), r2: Math.max(v.r, t.r) };
    let a = { r: v.r, c: v.c }, b = { r: t.r, c: t.c };
    let forward = a.r < b.r || (a.r === b.r && a.c <= b.c);
    if (!forward) [a, b] = [b, a];
    let c2 = b.c + (inclusive ? 1 : 0);
    if (!inclusive && b.r > a.r && b.c === 0) { const pr = b.r - 1; return { linewise: false, r1: a.r, c1: a.c, r2: pr, c2: v.lines[pr].length }; }
    return { linewise: false, r1: a.r, c1: a.c, r2: b.r, c2 };
  }

  /* ---------- visual selection ---------- */
  selection() {
    const v = this.v;
    let a = v.va || { r: v.r, c: v.c }, b = { r: v.r, c: v.c };
    if (a.r > b.r || (a.r === b.r && a.c > b.c)) [a, b] = [b, a];
    if (v.mode === 'vline') return { r1: a.r, c1: 0, r2: b.r, c2: Math.max(0, v.lines[b.r].length - 1), linewise: true };
    return { r1: a.r, c1: a.c, r2: b.r, c2: b.c, linewise: false };
  }
  leaveVisual() { const v = this.v; v.lastSel = this.selection(); v.va = null; if (v.mode === 'visual' || v.mode === 'vline') v.mode = 'normal'; this.clamp(); }

  /* ---------- rendering ---------- */
  renderLine(line, cursorC, sel) {
    // sel: [a, b] inclusive columns or null; cursorC: column or null
    if (!line.length) return cursorC !== null ? '<span class="cur"> </span>' : sel ? '<span class="vsel"> </span>' : ' ';
    const bounds = new Set([0, line.length]);
    if (cursorC !== null) { bounds.add(Math.min(cursorC, line.length)); bounds.add(Math.min(cursorC + 1, line.length)); }
    if (sel) { bounds.add(Math.max(0, Math.min(sel[0], line.length))); bounds.add(Math.min(sel[1] + 1, line.length)); }
    const pts = [...bounds].sort((x, y) => x - y);
    let html = '';
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      if (a === b) continue;
      const seg = esc(line.slice(a, b));
      const cls = [];
      if (sel && a >= sel[0] && a <= sel[1]) cls.push('vsel');
      if (cursorC !== null && a === cursorC) cls.push('cur');
      html += cls.length ? '<span class="' + cls.join(' ') + '">' + seg + '</span>' : seg;
    }
    if (cursorC !== null && cursorC >= line.length) html += '<span class="cur"> </span>';
    return html;
  }
  render() {
    const v = this.v;
    if (!v) return;
    const rows = [];
    const numW = v.showNumbers ? String(v.lines.length).length + 1 : 0;
    const vis = v.mode === 'visual' || v.mode === 'vline';
    const s = vis ? this.selection() : null;
    for (let i = 0; i < v.lines.length; i++) {
      const line = v.lines[i];
      let sel = null;
      if (s && i >= s.r1 && i <= s.r2) sel = s.linewise ? [0, Math.max(0, line.length - 1)] : [i === s.r1 ? s.c1 : 0, i === s.r2 ? s.c2 : Math.max(0, line.length - 1)];
      let body = this.renderLine(line, i === v.r ? v.c : null, sel);
      if (v.search && !sel && i !== v.r) { try { const re = new RegExp('(' + v.search + ')', 'g'); body = body.replace(re, '<span class="hl">$1</span>'); } catch (e) { /* ignore */ } }
      rows.push((v.showNumbers ? '<span class="lnum">' + String(i + 1).padStart(numW - 1) + ' </span>' : '') + body);
    }
    const approx = Math.max(0, Math.floor(this.textEl.clientHeight / 20) - v.lines.length);
    for (let i = 0; i < approx; i++) rows.push('<span class="tilde">~</span>');
    this.textEl.innerHTML = rows.join('\n');
    const mode = v.mode === 'insert' ? '-- INSERT --' : v.mode === 'visual' ? '-- VISUAL --' : v.mode === 'vline' ? '-- VISUAL LINE --' : '';
    this.leftEl.innerHTML = '<span class="mode">' + mode + '</span>' + (mode ? '  ' : '') + esc(v.name) + (v.modified ? ' [+]' : '');
    const pend = (v.opCount ? String(v.opCount) : '') + v.pending + v.count;
    this.rightEl.textContent = (pend ? pend + '   ' : '') + (v.r + 1) + ',' + (v.c + 1) + '   ' + (v.lines.length <= Math.floor(this.textEl.clientHeight / 20) ? 'All' : Math.round(v.r / Math.max(1, v.lines.length - 1) * 100) + '%');
    if (v.mode === 'cmd') this.cmdEl.textContent = ':' + v.cmdline;
    else if (v.mode === 'search') this.cmdEl.textContent = (v.searchDir > 0 ? '/' : '?') + v.cmdline;
    else if (v.message) this.cmdEl.innerHTML = v.msgErr ? '<span class="err">' + esc(v.message) + '</span>' : esc(v.message);
    else this.cmdEl.textContent = '';
    const cur = this.textEl.querySelector('.cur');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- keys ---------- */
  onKey(e) {
    const v = this.v;
    if (!v) return;
    const k = e.key;
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(k)) return;
    // Let the browser paste/copy: Cmd/Ctrl+V, Ctrl+Shift+V, Shift+Insert, Cmd/Ctrl+C on a mouse selection.
    if ((e.metaKey || e.ctrlKey) && ['v', 'V', 'c', 'C'].includes(k)) return;
    if (k === 'Insert' && e.shiftKey) return;
    e.preventDefault();
    if (v.replaying !== true && v.recActive) v.rec.push({ key: k, ctrlKey: !!e.ctrlKey, shiftKey: !!e.shiftKey });

    if (v.mode === 'cmd' || v.mode === 'search') {
      if (k === 'Enter') {
        const line = v.cmdline; v.cmdline = '';
        if (v.mode === 'search') { v.mode = 'normal'; if (line) v.search = line; this.doSearch(v.searchDir); }
        else { v.mode = 'normal'; this.execCmd(line); }
      } else if (k === 'Escape') { v.mode = 'normal'; v.cmdline = ''; }
      else if (k === 'Backspace') { if (v.cmdline.length) v.cmdline = v.cmdline.slice(0, -1); else v.mode = 'normal'; }
      else if (e.ctrlKey && k === 'u') v.cmdline = '';
      else if (k.length === 1 && !e.ctrlKey) v.cmdline += k;
      if (this.v) { this.finishCommandIfIdle(); this.render(); }
      return;
    }

    if (v.mode === 'insert') { this.insertKey(e); this.finishCommandIfIdle(); this.render(); return; }
    if (v.mode === 'visual' || v.mode === 'vline') { this.visualKey(e); if (this.v) { this.finishCommandIfIdle(); this.render(); } return; }

    /* ---- normal mode ---- */
    v.message = '';
    // a fresh command starts recording (for `.`); u / Ctrl-R / . never do
    if (!v.pending && !v.count && !v.recActive && !v.replaying && k !== '.' && k !== 'u' && !(e.ctrlKey && k === 'r')) { v.rec = [{ key: k, ctrlKey: !!e.ctrlKey, shiftKey: !!e.shiftKey }]; v.recActive = true; v.recUndo = v.undo.length; }
    if (/^[1-9]$/.test(k) || (k === '0' && v.count)) { v.count += k; this.render(); return; }
    const count = (v.opCount || 1) * (v.count ? parseInt(v.count, 10) : 1);
    const hasCount = !!(v.opCount || v.count);
    const pending = v.pending;
    v.pending = ''; v.count = '';
    const done = () => { v.opCount = 0; this.finishCommandIfIdle(); this.render(); };

    if (pending === 'r') { if (k.length === 1) { this.snapshot(); const l = v.lines[v.r]; if (l.length) { v.lines[v.r] = l.slice(0, v.c) + k.repeat(Math.min(count, l.length - v.c)) + l.slice(v.c + Math.min(count, l.length - v.c)); v.modified = true; } } return done(); }
    if (pending === 'z') return done();
    if (pending === 'g') {
      if (k === 'g') { const t = this.motion('gg', count, hasCount); v.r = t.r; v.c = t.c; this.clamp(); }
      else if (k === 'v' && v.lastSel) { v.va = { r: v.lastSel.r1, c: v.lastSel.c1 }; v.r = v.lastSel.r2; v.c = v.lastSel.c2; v.mode = v.lastSel.linewise ? 'vline' : 'visual'; this.clamp(); }
      else if (k === 'J') { this.snapshot(); if (v.r < v.lines.length - 1) { v.c = v.lines[v.r].length; v.lines.splice(v.r, 2, v.lines[v.r] + v.lines[v.r + 1]); v.modified = true; } }
      else if (k === 'u' || k === 'U' || k === '~') { v.pending = 'g' + k; v.opCount = count; this.render(); return; }
      return done();
    }
    if (['f', 't', 'F', 'T'].includes(pending)) { if (k.length === 1) { const t = this.motion(pending, count, hasCount, e, k); if (t) { v.r = t.r; v.c = t.c; this.clamp(); } } return done(); }

    const isOp = (p) => ['d', 'y', 'c', '>', '<', 'gu', 'gU', 'g~'].includes(p);
    if (isOp(pending)) {
      const opChar = pending.length === 2 ? pending[1] : pending;  // gu -> u, gU -> U, g~ -> ~
      const opKey = { gu: 'u', gU: 'U', 'g~': '~' }[pending] || pending;
      const lastOf = pending.length === 2 ? pending[1] : pending;
      if (k === lastOf || (pending === 'g~' && k === '~')) { this.applyOperator(opKey, { linewise: true, r1: v.r, r2: Math.min(v.lines.length - 1, v.r + count - 1) }, count); return done(); }
      if (k === 'g') { v.pending = pending + 'g'; v.opCount = count; this.render(); return; }
      if (k === 'i' || k === 'a') { v.pending = pending + k; v.opCount = count; this.render(); return; }
      if (['f', 't', 'F', 'T'].includes(k)) { v.pending = pending + k; v.opCount = count; this.render(); return; }
      let motionKey = k;
      if (opKey === 'c' && (k === 'w' || k === 'W')) motionKey = k === 'w' ? 'e' : 'E';   // cw acts like ce
      const t = this.motion(motionKey, count, hasCount, e);
      if (!t) return done();
      if (opKey === 'c' && motionKey === 'e' && /\s/.test(v.lines[v.r][v.c] || ' ')) { /* cw on whitespace changes just the whitespace */ const m = v.lines[v.r].slice(v.c).match(/^\s+/); this.applyOperator('c', { linewise: false, r1: v.r, c1: v.c, r2: v.r, c2: v.c + (m ? m[0].length : 1) }); return done(); }
      this.applyOperator(opKey, this.rangeToTarget(t, t.inclusive), count);
      return done();
    }
    if (pending.length >= 2 && isOp(pending.slice(0, -1))) {
      const base = pending.slice(0, -1), tail = pending.slice(-1);
      const opKey = { gu: 'u', gU: 'U', 'g~': '~' }[base] || base;
      if (tail === 'g') { if (k === 'g') { const t = this.motion('gg', count, hasCount); this.applyOperator(opKey, this.rangeToTarget(t, false), count); } return done(); }
      if (tail === 'i' || tail === 'a') { const obj = this.textObject(tail, k); if (obj) this.applyOperator(opKey, obj.linewise ? { linewise: true, r1: obj.r1, r2: obj.r2 } : Object.assign({ linewise: false }, obj), count); return done(); }
      if (['f', 't', 'F', 'T'].includes(tail)) { const t = this.motion(tail, count, hasCount, e, k); if (t) this.applyOperator(opKey, this.rangeToTarget(t, t.inclusive), count); return done(); }
      return done();
    }
    if (pending.length === 3 && pending.startsWith('g') && isOp(pending.slice(0, 2))) { // gug, gUg + g
      const opKey = { gu: 'u', gU: 'U', 'g~': '~' }[pending.slice(0, 2)];
      if (k === 'g') { const t = this.motion('gg', count, hasCount); this.applyOperator(opKey, this.rangeToTarget(t, false), count); }
      return done();
    }

    const mv = this.motion(k, count, hasCount, e);
    if (mv) { v.r = mv.r; v.c = mv.c; this.clamp(); return done(); }

    switch (k) {
      case 'g': case 'd': case 'y': case 'c': case 'r': case '>': case '<': case 'f': case 't': case 'F': case 'T': case 'z': v.pending = k; v.opCount = hasCount ? count : 0; this.render(); return;
      case 'v': v.mode = 'visual'; v.va = { r: v.r, c: v.c }; break;
      case 'V': v.mode = 'vline'; v.va = { r: v.r, c: v.c }; break;
      case 'x': case 'Delete': { const l = v.lines[v.r]; if (l.length) this.applyOperator('d', { linewise: false, r1: v.r, c1: v.c, r2: v.r, c2: Math.min(l.length, v.c + count) }); break; }
      case 'X': if (v.c > 0) this.applyOperator('d', { linewise: false, r1: v.r, c1: Math.max(0, v.c - count), r2: v.r, c2: v.c }); break;
      case 'D': this.applyOperator('d', { linewise: false, r1: v.r, c1: v.c, r2: Math.min(v.lines.length - 1, v.r + count - 1), c2: v.lines[Math.min(v.lines.length - 1, v.r + count - 1)].length }); break;
      case 'C': this.applyOperator('c', { linewise: false, r1: v.r, c1: v.c, r2: Math.min(v.lines.length - 1, v.r + count - 1), c2: v.lines[Math.min(v.lines.length - 1, v.r + count - 1)].length }); break;
      case 'S': this.applyOperator('c', { linewise: true, r1: v.r, r2: Math.min(v.lines.length - 1, v.r + count - 1) }); break;
      case 's': { const l = v.lines[v.r]; this.applyOperator('c', { linewise: false, r1: v.r, c1: v.c, r2: v.r, c2: Math.min(l.length, v.c + count) }); break; }
      case 'Y': this.applyOperator('y', { linewise: true, r1: v.r, r2: Math.min(v.lines.length - 1, v.r + count - 1) }); break;
      case 'J': this.applyOperator('J', { linewise: true, r1: v.r, r2: v.r + Math.max(1, count - 1) }); break;
      case '~': { const l = v.lines[v.r]; if (l.length) { this.applyOperator('~', { linewise: false, r1: v.r, c1: v.c, r2: v.r, c2: Math.min(l.length, v.c + count) }); v.c = Math.min(l.length - 1, v.c + count); this.clamp(); } break; }
      case 'p': case 'P': {
        if (v.reg === null) break;
        this.snapshot();
        for (let i = 0; i < count; i++) {
          if (v.regLinewise) { const ls = v.reg.split('\n'); const at = k === 'p' ? v.r + 1 : v.r; v.lines.splice(at, 0, ...ls); v.r = at; v.c = this.firstNonBlank(v.r); }
          else { const l = v.lines[v.r]; const at = k === 'p' ? Math.min(v.c + 1, l.length) : v.c; const parts = v.reg.split('\n'); if (parts.length === 1) { v.lines[v.r] = l.slice(0, at) + v.reg + l.slice(at); v.c = at + v.reg.length - 1; } else { v.lines.splice(v.r, 1, l.slice(0, at) + parts[0], ...parts.slice(1, -1), parts[parts.length - 1] + l.slice(at)); v.r += parts.length - 1; v.c = parts[parts.length - 1].length - 1; } }
        }
        v.modified = true; this.clamp(); break;
      }
      case 'u': { for (let i = 0; i < count; i++) { const s = v.undo.pop(); if (!s) { this.setMsg('Already at oldest change'); break; } v.redo.push({ lines: v.lines.slice(), r: v.r, c: v.c }); v.lines = s.lines; v.r = s.r; v.c = s.c; } v.modified = this.text() !== v.savedText; this.clamp(); break; }
      case '.': { if (v.lastChange) { const seq = v.lastChange; v.replaying = true; for (let i = 0; i < count; i++) for (const ent of seq) { if (ent.paste) this.pasteText(ent.paste); else this.onKey({ key: ent.key, ctrlKey: ent.ctrlKey, shiftKey: ent.shiftKey, metaKey: false, preventDefault() {} }); } v.replaying = false; } break; }
      case 'i': this.snapshot(); v.mode = 'insert'; break;
      case 'I': this.snapshot(); v.mode = 'insert'; v.c = this.firstNonBlank(v.r); break;
      case 'a': this.snapshot(); v.mode = 'insert'; if (v.lines[v.r].length) v.c++; break;
      case 'A': this.snapshot(); v.mode = 'insert'; v.c = v.lines[v.r].length; break;
      case 'o': { this.snapshot(); const ind = this.indentOf(v.lines[v.r]); v.lines.splice(v.r + 1, 0, ind); v.r++; v.c = ind.length; v.mode = 'insert'; v.modified = true; break; }
      case 'O': { this.snapshot(); const ind = this.indentOf(v.lines[v.r]); v.lines.splice(v.r, 0, ind); v.c = ind.length; v.mode = 'insert'; v.modified = true; break; }
      case ':': v.mode = 'cmd'; v.cmdline = ''; break;
      case '/': v.mode = 'search'; v.searchDir = 1; v.cmdline = ''; break;
      case '?': v.mode = 'search'; v.searchDir = -1; v.cmdline = ''; break;
      case 'n': this.doSearch(v.searchDir); break;
      case 'N': this.doSearch(-v.searchDir); break;
      case '*': case '#': { const m = v.lines[v.r].slice(v.c).match(/\w+/) || v.lines[v.r].match(/\w+/); if (m) { v.search = '\\b' + m[0] + '\\b'; this.doSearch(k === '*' ? 1 : -1); } break; }
      case 'Escape': v.opCount = 0; break;
      default:
        if (e.ctrlKey && k === 'r') { for (let i = 0; i < count; i++) { const s = v.redo.pop(); if (!s) { this.setMsg('Already at newest change'); break; } v.undo.push({ lines: v.lines.slice(), r: v.r, c: v.c }); v.lines = s.lines; v.r = s.r; v.c = s.c; } v.modified = this.text() !== v.savedText; this.clamp(); }
        else if (e.ctrlKey && k === 'c') { this.setMsg('Type  :qa!  and press <Enter> to abandon all changes and exit Vim'); }
    }
    done();
  }

  visualKey(e) {
    const v = this.v, k = e.key;
    v.message = '';
    if (/^[1-9]$/.test(k) || (k === '0' && v.count)) { v.count += k; return; }
    const count = v.count ? parseInt(v.count, 10) : 1, hasCount = !!v.count;
    const pending = v.pending;
    v.pending = ''; v.count = '';
    if (pending === 'i' || pending === 'a') { const obj = this.textObject(pending, k); if (obj) { v.va = { r: obj.r1, c: obj.c1 }; v.r = obj.r2; v.c = obj.linewise ? Math.max(0, v.lines[obj.r2].length - 1) : Math.max(0, obj.c2 - 1); if (obj.linewise) v.mode = 'vline'; this.clamp(); } return; }
    if (pending === 'g') { if (k === 'g') { const t = this.motion('gg', count, hasCount); v.r = t.r; v.c = t.c; this.clamp(); } return; }
    if (['f', 't', 'F', 'T'].includes(pending)) { const t = this.motion(pending, count, hasCount, e, k); if (t) { v.r = t.r; v.c = t.c; this.clamp(); } return; }
    if (pending === 'r') { if (k.length === 1) { const s = this.selection(); this.snapshot(); for (let i = s.r1; i <= s.r2; i++) { const a = s.linewise || i > s.r1 ? 0 : s.c1, b = s.linewise || i < s.r2 ? v.lines[i].length - 1 : s.c2; if (v.lines[i].length) v.lines[i] = v.lines[i].slice(0, a) + k.repeat(b - a + 1) + v.lines[i].slice(b + 1); } v.modified = true; this.leaveVisual(); v.r = s.r1; v.c = s.c1; this.clamp(); } return; }
    const mv = this.motion(k, count, hasCount, e);
    if (mv) { v.r = mv.r; v.c = mv.c; this.clamp(); return; }
    const s = this.selection();
    const asRange = () => (s.linewise ? { linewise: true, r1: s.r1, r2: s.r2 } : { linewise: false, r1: s.r1, c1: s.c1, r2: s.r2, c2: Math.min(v.lines[s.r2].length, s.c2 + 1) });
    switch (k) {
      case 'Escape': this.leaveVisual(); break;
      case 'v': if (v.mode === 'visual') this.leaveVisual(); else v.mode = 'visual'; break;
      case 'V': if (v.mode === 'vline') this.leaveVisual(); else v.mode = 'vline'; break;
      case 'o': case 'O': { const a = v.va; v.va = { r: v.r, c: v.c }; v.r = a.r; v.c = a.c; this.clamp(); break; }
      case 'g': case 'i': case 'a': case 'f': case 't': case 'F': case 'T': case 'r': v.pending = k; break;
      case 'd': case 'x': case 'Delete': this.leaveVisual(); this.applyOperator('d', asRange()); break;
      case 'X': case 'D': this.leaveVisual(); this.applyOperator('d', { linewise: true, r1: s.r1, r2: s.r2 }); break;
      case 'y': this.leaveVisual(); this.applyOperator('y', asRange()); break;
      case 'Y': this.leaveVisual(); this.applyOperator('y', { linewise: true, r1: s.r1, r2: s.r2 }); break;
      case 'c': case 's': this.leaveVisual(); this.applyOperator('c', asRange()); break;
      case 'C': case 'S': case 'R': this.leaveVisual(); this.applyOperator('c', { linewise: true, r1: s.r1, r2: s.r2 }); break;
      case '>': case '<': this.leaveVisual(); this.applyOperator(k, { linewise: true, r1: s.r1, r2: s.r2 }, count); break;
      case 'J': this.leaveVisual(); this.applyOperator('J', { linewise: true, r1: s.r1, r2: Math.max(s.r2, s.r1 + 1) }); break;
      case '~': case 'u': case 'U': this.leaveVisual(); this.applyOperator(k, asRange()); break;
      case 'p': case 'P': {
        if (v.reg === null) { this.leaveVisual(); break; }
        const reg = v.reg, lw = v.regLinewise;
        this.leaveVisual(); this.applyOperator('d', asRange());
        if (lw) { const ls = reg.split('\n'); const at = s.linewise ? v.r : v.r + 1; if (s.linewise) v.lines.splice(at, 0, ...ls); else { const l = v.lines[v.r]; v.lines.splice(v.r, 1, l.slice(0, v.c), ...ls, l.slice(v.c)); } v.r = at; v.c = this.firstNonBlank(v.r); }
        else { const l = v.lines[v.r]; const at = s.linewise ? 0 : v.c; const parts = reg.split('\n'); if (parts.length === 1) { v.lines[v.r] = l.slice(0, at) + reg + l.slice(at); v.c = at + reg.length - 1; } else { v.lines.splice(v.r, 1, l.slice(0, at) + parts[0], ...parts.slice(1, -1), parts[parts.length - 1] + l.slice(at)); v.r += parts.length - 1; } }
        v.reg = s.linewise ? v.reg : v.reg; v.modified = true; this.clamp(); break;
      }
      case ':': this.leaveVisual(); v.mode = 'cmd'; v.cmdline = "'<,'>"; break;
      case '/': this.leaveVisual(); v.mode = 'search'; v.searchDir = 1; v.cmdline = ''; break;
      case 'n': this.doSearch(v.searchDir); break;
      case 'N': this.doSearch(-v.searchDir); break;
      case 'I': case 'A': { const r1 = s.r1; this.leaveVisual(); this.snapshot(); v.r = k === 'I' ? r1 : s.r2; v.c = k === 'I' ? (s.linewise ? this.firstNonBlank(r1) : s.c1) : (s.linewise ? v.lines[s.r2].length : Math.min(v.lines[s.r2].length, s.c2 + 1)); v.mode = 'insert'; break; }
      default: break;
    }
  }

  /* a command is finished when we are back in normal mode with nothing pending */
  finishCommandIfIdle() {
    const v = this.v;
    if (!v || !v.recActive || v.replaying) return;
    if (v.mode === 'normal' && !v.pending && !v.count) { if (v.undo.length > v.recUndo) v.lastChange = v.rec.slice(); v.recActive = false; v.rec = []; }
  }

  insertKey(e) {
    const v = this.v;
    const k = e.key;
    v.message = '';
    if (k === 'Escape') { v.mode = 'normal'; v.c--; this.clamp(); return; }
    if (k === 'Enter') {
      const line = v.lines[v.r];
      const ind = this.indentOf(line);
      const before = line.slice(0, v.c), after = line.slice(v.c);
      v.lines.splice(v.r, 1, before, ind + after.replace(/^\s+/, ''));
      v.r++; v.c = ind.length; v.modified = true; return;
    }
    if (k === 'Backspace') {
      if (v.c > 0) {
        const line = v.lines[v.r];
        const back = /^\s+$/.test(line.slice(0, v.c)) && v.c % 2 === 0 && v.c >= 2 ? 2 : 1;
        v.lines[v.r] = line.slice(0, v.c - back) + line.slice(v.c); v.c -= back; v.modified = true;
      } else if (v.r > 0) { const prev = v.lines[v.r - 1]; v.c = prev.length; v.lines.splice(v.r - 1, 2, prev + v.lines[v.r]); v.r--; v.modified = true; }
      return;
    }
    if (k === 'Delete') { const l = v.lines[v.r]; if (v.c < l.length) { v.lines[v.r] = l.slice(0, v.c) + l.slice(v.c + 1); v.modified = true; } else if (v.r < v.lines.length - 1) { v.lines.splice(v.r, 2, l + v.lines[v.r + 1]); v.modified = true; } return; }
    if (k === 'ArrowLeft') { v.c--; this.clamp(); return; }
    if (k === 'ArrowRight') { v.c++; this.clamp(); return; }
    if (k === 'ArrowUp') { if (v.r > 0) v.r--; this.clamp(); return; }
    if (k === 'ArrowDown') { if (v.r < v.lines.length - 1) v.r++; this.clamp(); return; }
    if (k === 'Home') { v.c = 0; return; }
    if (k === 'End') { v.c = v.lines[v.r].length; return; }
    if (k === 'Tab') { const l = v.lines[v.r]; v.lines[v.r] = l.slice(0, v.c) + '  ' + l.slice(v.c); v.c += 2; v.modified = true; return; }
    if (e.ctrlKey && k === 'w') { const before = v.lines[v.r].slice(0, v.c); const m = before.match(/(\S+\s*|\s+)$/); if (m) { v.lines[v.r] = before.slice(0, -m[0].length) + v.lines[v.r].slice(v.c); v.c -= m[0].length; v.modified = true; } return; }
    if (e.ctrlKey && k === 'u') { const l = v.lines[v.r]; const ind = this.indentOf(l); const from = v.c > ind.length ? ind.length : 0; v.lines[v.r] = l.slice(0, from) + l.slice(v.c); v.c = from; v.modified = true; return; }
    if (k.length === 1 && !e.ctrlKey && !e.metaKey) { const l = v.lines[v.r]; v.lines[v.r] = l.slice(0, v.c) + k + l.slice(v.c); v.c++; v.modified = true; }
  }

  /* Paste from the browser clipboard. Insert mode and normal mode insert at the
     cursor exactly like vim with bracketed paste (before the cursor character);
     visual mode replaces the selection; : and / append to the command line.
     Text goes in verbatim (no autoindent), so YAML from the docs keeps its shape. */
  pasteText(text) {
    const v = this.v;
    if (!v || typeof text !== 'string' || !text.length) return;
    const parts = text.replace(/\r/g, '').split('\n');
    if (v.mode === 'cmd' || v.mode === 'search') { v.cmdline += parts[0]; this.render(); return; }
    if (!v.replaying) { if (!v.recActive) { v.rec = []; v.recActive = true; v.recUndo = v.undo.length; } v.rec.push({ paste: text }); }
    if (v.mode === 'visual' || v.mode === 'vline') {
      const sel = this.selection();
      this.leaveVisual();
      this.applyOperator('d', sel.linewise ? { linewise: true, r1: sel.r1, r2: sel.r2 } : { linewise: false, r1: sel.r1, c1: sel.c1, r2: sel.r2, c2: Math.min(v.lines[sel.r2].length, sel.c2 + 1) });
      if (sel.linewise) { v.lines.splice(v.r, 0, ''); v.c = 0; }
    } else this.snapshot();
    const emptyLine = v.lines[v.r] === '';
    const l = v.lines[v.r];
    const before = l.slice(0, v.c), after = l.slice(v.c);
    if (parts.length === 1) { v.lines[v.r] = before + parts[0] + after; v.c += parts[0].length; }
    else { v.lines.splice(v.r, 1, before + parts[0], ...parts.slice(1, -1), parts[parts.length - 1] + after); v.r += parts.length - 1; v.c = parts[parts.length - 1].length; }
    // a whole-line paste onto an empty line in normal mode leaves a stray empty line; drop it
    if (v.mode !== 'insert' && emptyLine && parts.length > 1 && parts[parts.length - 1] === '' && v.lines[v.r] === '' && v.lines.length > 1) { v.lines.splice(v.r, 1); v.r = Math.max(0, v.r - 1); v.c = 0; }
    else if (v.mode !== 'insert' && v.c > 0) v.c--;   // normal mode: cursor on the last pasted character
    v.modified = true;
    this.clamp();
    this.finishCommandIfIdle();
    this.render();
  }
}
