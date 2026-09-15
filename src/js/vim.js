/* vim.js — a modal editor good enough for exam YAML: normal/insert/
   command/search modes, counts, motions (h j k l w b 0 ^ $ gg G),
   edits (x X r dd D yy p P J >> << cw cc o O i I a A), undo/redo,
   :w :q :wq :x :q! :N :set nu :%s/a/b/g :noh, / n N, autoindent,
   Tab = two spaces. open() returns a promise resolved on quit. */

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

  open({ text = '', name = '[No Name]', validate = null, onSave = null }) {
    return new Promise((resolve) => {
      this.v = {
        lines: text.length ? text.replace(/\n$/, '').split('\n') : [''],
        r: 0, c: 0, mode: 'normal', cmdline: '', pending: '', count: '',
        name, validate, onSave, resolve,
        modified: false, everSaved: false, savedText: text,
        undo: [], redo: [], reg: null, regLinewise: false,
        search: null, searchDir: 1, showNumbers: false, message: '"' + name + '" ' + (text.length ? text.replace(/\n$/, '').split('\n').length + 'L, ' + text.length + 'B' : '[New File]'), msgErr: false,
        wantC: 0,
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
    v.resolve({ saved, text: v.lines.join('\n') + '\n' });
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

  save(newName) {
    const v = this.v;
    const content = this.text();
    if (v.validate) { const err = v.validate(content); if (err) { this.setMsg(err.split('\n')[0], true); return false; } }
    if (v.onSave) { const err = v.onSave(content, newName); if (err) { this.setMsg(err, true); return false; } }
    if (newName) v.name = newName;
    v.modified = false; v.everSaved = true; v.savedText = content;
    this.setMsg('"' + v.name + '" ' + v.lines.length + 'L, ' + content.length + 'B written');
    return true;
  }

  execCmd(raw) {
    const v = this.v;
    const m = raw.trim();
    if (m === '') return;
    if (m === 'w') { this.save(); return; }
    if (m.startsWith('w ')) { this.save(m.slice(2).trim()); return; }
    if (m === 'q') { if (v.modified) return this.setMsg('E37: No write since last change (add ! to override)', true); return this.close(v.everSaved); }
    if (m === 'q!') return this.close(v.everSaved);
    if (m === 'wq' || m === 'x' || m === 'wq!' || m === 'x!') { if (this.save()) this.close(true); return; }
    if (/^\d+$/.test(m)) { v.r = Math.min(v.lines.length, parseInt(m, 10)) - 1; v.c = 0; this.clamp(); return; }
    if (m === 'set nu' || m === 'set number') { v.showNumbers = true; return; }
    if (m === 'set nonu' || m === 'set nonumber') { v.showNumbers = false; return; }
    if (m.startsWith('set ')) return;
    if (m === 'noh' || m === 'nohlsearch') { v.search = null; return; }
    const sub = m.match(/^(%|\d+,\d+|\d+)?s\/((?:\\\/|[^/])*)\/((?:\\\/|[^/])*)\/?([gi]*)$/);
    if (sub) {
      const range = sub[1];
      let from = v.r, to = v.r;
      if (range === '%') { from = 0; to = v.lines.length - 1; }
      else if (range && range.includes(',')) { const [a, b] = range.split(',').map(x => parseInt(x, 10) - 1); from = a; to = b; }
      else if (range) { from = to = parseInt(range, 10) - 1; }
      let re;
      try { re = new RegExp(sub[2].replace(/\\\//g, '/'), (sub[4].includes('g') ? 'g' : '') + (sub[4].includes('i') ? 'i' : '')); } catch (e) { return this.setMsg('E486: Pattern not found: ' + sub[2], true); }
      this.snapshot();
      let n = 0;
      for (let i = from; i <= to && i < v.lines.length; i++) {
        const before = v.lines[i];
        const after = before.replace(re, sub[3].replace(/\\\//g, '/'));
        if (after !== before) { n += (before.match(new RegExp(re.source, 'g' + (re.flags.includes('i') ? 'i' : ''))) || []).length; v.lines[i] = after; }
      }
      if (n) { v.modified = true; this.setMsg(n + ' substitution' + (n > 1 ? 's' : '') + ' on ' + (to - from + 1) + ' line' + (to - from ? 's' : '')); } else this.setMsg('E486: Pattern not found: ' + sub[2], true);
      this.clamp();
      return;
    }
    this.setMsg('E492: Not an editor command: ' + m, true);
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
      const matches = [...line.matchAll(re)].map(x => x.index);
      const cands = step === 0 ? matches.filter(x => dir > 0 ? x > v.c : x < v.c) : (dir > 0 ? matches : matches.slice().reverse());
      if (cands.length) { v.r = i; v.c = dir > 0 ? cands[0] : cands[0]; if (step === 0 && dir < 0) v.c = cands[cands.length - 1] !== undefined ? Math.max(...cands) : v.c; this.clamp(); return; }
    }
    this.setMsg('E486: Pattern not found: ' + v.search, true);
  }

  wordForward() {
    const v = this.v;
    const line = v.lines[v.r];
    const rest = line.slice(v.c);
    const m = rest.match(/^(\w+|[^\w\s]+)?\s*/);
    let nc = v.c + (m ? m[0].length : 0);
    if (nc >= line.length && v.r < v.lines.length - 1) { v.r++; v.c = 0; const l2 = v.lines[v.r]; const ws = l2.match(/^\s*/)[0].length; v.c = ws; return; }
    v.c = Math.min(nc, Math.max(0, line.length - 1));
  }
  wordBack() {
    const v = this.v;
    if (v.c === 0) { if (v.r > 0) { v.r--; v.c = Math.max(0, v.lines[v.r].length - 1); } return; }
    const before = v.lines[v.r].slice(0, v.c);
    const m = before.match(/(\w+|[^\w\s]+)\s*$/);
    v.c = m ? before.length - m[0].length : 0;
  }

  /* ---------- rendering ---------- */
  render() {
    const v = this.v;
    if (!v) return;
    const rows = [];
    const numW = v.showNumbers ? String(v.lines.length).length + 1 : 0;
    for (let i = 0; i < v.lines.length; i++) {
      const line = v.lines[i];
      let body;
      if (i === v.r) {
        const c = Math.min(v.c, Math.max(0, line.length));
        const ch = line[c] !== undefined ? line[c] : ' ';
        body = esc(line.slice(0, c)) + '<span class="cur">' + esc(ch) + '</span>' + esc(line.slice(c + 1));
      } else {
        body = esc(line) || ' ';
      }
      if (v.search) { try { const re = new RegExp('(' + v.search + ')', 'g'); body = body.replace(re, '<span class="hl">$1</span>'); } catch (e) { /* ignore */ } }
      rows.push((v.showNumbers ? '<span class="lnum">' + String(i + 1).padStart(numW - 1) + ' </span>' : '') + body);
    }
    const approx = Math.max(0, Math.floor(this.textEl.clientHeight / 20) - v.lines.length);
    for (let i = 0; i < approx; i++) rows.push('<span class="tilde">~</span>');
    this.textEl.innerHTML = rows.join('\n');
    const mode = v.mode === 'insert' ? '-- INSERT --' : v.mode === 'search' ? '' : '';
    this.leftEl.innerHTML = '<span class="mode">' + mode + '</span>' + (mode ? '  ' : '') + esc(v.name) + (v.modified ? ' [+]' : '');
    this.rightEl.textContent = (v.pending || v.count ? (v.count + v.pending) + '   ' : '') + (v.r + 1) + ',' + (v.c + 1) + '   ' + (v.lines.length <= Math.floor(this.textEl.clientHeight / 20) ? 'All' : Math.round(v.r / Math.max(1, v.lines.length - 1) * 100) + '%');
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
    if (e.metaKey && (k === 'v' || k === 'c')) return; // let the browser paste/copy
    e.preventDefault();

    if (v.mode === 'cmd' || v.mode === 'search') {
      if (k === 'Enter') {
        const line = v.cmdline; v.cmdline = '';
        if (v.mode === 'search') { v.mode = 'normal'; if (line) v.search = line; this.doSearch(v.searchDir); }
        else { v.mode = 'normal'; this.execCmd(line); }
      } else if (k === 'Escape') { v.mode = 'normal'; v.cmdline = ''; }
      else if (k === 'Backspace') { if (v.cmdline.length) v.cmdline = v.cmdline.slice(0, -1); else v.mode = 'normal'; }
      else if (k.length === 1 && !e.ctrlKey) v.cmdline += k;
      if (this.v) this.render();
      return;
    }

    if (v.mode === 'insert') { this.insertKey(e); this.render(); return; }

    /* normal mode */
    v.message = '';
    if (/^[1-9]$/.test(k) || (k === '0' && v.count)) { v.count += k; this.render(); return; }
    const count = v.count ? parseInt(v.count, 10) : 1;
    const pending = v.pending;
    v.pending = ''; v.count = '';

    if (pending === 'r') { if (k.length === 1) { this.snapshot(); const l = v.lines[v.r]; if (l.length) { v.lines[v.r] = l.slice(0, v.c) + k + l.slice(v.c + 1); v.modified = true; } } this.render(); return; }
    if (pending === 'd') {
      if (k === 'd') { this.snapshot(); const n = Math.min(count, v.lines.length - v.r); v.reg = v.lines.slice(v.r, v.r + n).join('\n'); v.regLinewise = true; v.lines.splice(v.r, n); if (!v.lines.length) v.lines = ['']; v.modified = true; this.clamp(); }
      else if (k === 'w') { this.snapshot(); const line = v.lines[v.r]; const m = line.slice(v.c).match(/^(\w+|[^\w\s]+)?\s*/); const len = m ? m[0].length : 1; v.reg = line.slice(v.c, v.c + len); v.regLinewise = false; v.lines[v.r] = line.slice(0, v.c) + line.slice(v.c + len); v.modified = true; this.clamp(); }
      else if (k === '$' || k === 'D') { this.snapshot(); v.reg = v.lines[v.r].slice(v.c); v.regLinewise = false; v.lines[v.r] = v.lines[v.r].slice(0, v.c); v.modified = true; this.clamp(); }
      else if (k === 'G') { this.snapshot(); v.reg = v.lines.slice(v.r).join('\n'); v.regLinewise = true; v.lines.splice(v.r); if (!v.lines.length) v.lines = ['']; v.modified = true; this.clamp(); }
      this.render(); return;
    }
    if (pending === 'y') {
      if (k === 'y') { const n = Math.min(count, v.lines.length - v.r); v.reg = v.lines.slice(v.r, v.r + n).join('\n'); v.regLinewise = true; this.setMsg(n > 1 ? n + ' lines yanked' : ''); }
      else if (k === 'w') { const line = v.lines[v.r]; const m = line.slice(v.c).match(/^(\w+|[^\w\s]+)?\s*/); v.reg = line.slice(v.c, v.c + (m ? m[0].length : 1)); v.regLinewise = false; }
      this.render(); return;
    }
    if (pending === 'c') {
      if (k === 'w' || k === 'e') { this.snapshot(); const line = v.lines[v.r]; const m = line.slice(v.c).match(/^(\w+|[^\w\s]+)?/); const len = m && m[0] ? m[0].length : 0; v.lines[v.r] = line.slice(0, v.c) + line.slice(v.c + len); v.mode = 'insert'; v.modified = true; }
      else if (k === 'c') { this.snapshot(); const ind = this.indentOf(v.lines[v.r]); v.lines[v.r] = ind; v.c = ind.length; v.mode = 'insert'; v.modified = true; }
      else if (k === '$') { this.snapshot(); v.lines[v.r] = v.lines[v.r].slice(0, v.c); v.mode = 'insert'; v.modified = true; }
      this.render(); return;
    }
    if (pending === 'g') { if (k === 'g') { v.r = v.count ? count - 1 : 0; v.c = 0; this.clamp(); } this.render(); return; }
    if (pending === '>' || pending === '<') {
      if (k === pending) { this.snapshot(); for (let i = v.r; i < Math.min(v.lines.length, v.r + count); i++) v.lines[i] = pending === '>' ? '  ' + v.lines[i] : v.lines[i].replace(/^ {1,2}/, ''); v.modified = true; this.clamp(); }
      this.render(); return;
    }

    const rep = (fn) => { for (let i = 0; i < count; i++) fn(); };
    switch (k) {
      case 'h': case 'ArrowLeft': case 'Backspace': rep(() => { v.c--; }); this.clamp(); break;
      case 'l': case 'ArrowRight': case ' ': rep(() => { v.c++; }); this.clamp(); break;
      case 'j': case 'ArrowDown': case 'Enter': rep(() => { if (v.r < v.lines.length - 1) v.r++; }); this.clamp(); break;
      case 'k': case 'ArrowUp': rep(() => { if (v.r > 0) v.r--; }); this.clamp(); break;
      case '0': case 'Home': v.c = 0; break;
      case '^': v.c = this.indentOf(v.lines[v.r]).length; this.clamp(); break;
      case '$': case 'End': v.c = Math.max(0, v.lines[v.r].length - 1); break;
      case 'w': rep(() => this.wordForward()); break;
      case 'b': rep(() => this.wordBack()); break;
      case 'G': v.r = v.count ? Math.min(v.lines.length, count) - 1 : v.lines.length - 1; v.c = 0; this.clamp(); break;
      case 'g': case 'd': case 'y': case 'c': case 'r': case '>': case '<': v.pending = k; break;
      case 'x': this.snapshot(); rep(() => { const l = v.lines[v.r]; if (l.length) { v.lines[v.r] = l.slice(0, v.c) + l.slice(v.c + 1); v.modified = true; } }); this.clamp(); break;
      case 'X': this.snapshot(); rep(() => { if (v.c > 0) { const l = v.lines[v.r]; v.lines[v.r] = l.slice(0, v.c - 1) + l.slice(v.c); v.c--; v.modified = true; } }); break;
      case 'D': this.snapshot(); v.reg = v.lines[v.r].slice(v.c); v.regLinewise = false; v.lines[v.r] = v.lines[v.r].slice(0, v.c); v.modified = true; this.clamp(); break;
      case 'J': this.snapshot(); rep(() => { if (v.r < v.lines.length - 1) { const next = v.lines[v.r + 1].replace(/^\s+/, ''); v.c = v.lines[v.r].length; v.lines[v.r] = v.lines[v.r] + (next ? ' ' + next : ''); v.lines.splice(v.r + 1, 1); v.modified = true; } }); this.clamp(); break;
      case 'p': case 'P': {
        if (v.reg === null) break;
        this.snapshot();
        rep(() => {
          if (v.regLinewise) { const ls = v.reg.split('\n'); const at = k === 'p' ? v.r + 1 : v.r; v.lines.splice(at, 0, ...ls); v.r = at; v.c = this.indentOf(v.lines[v.r]).length; }
          else { const l = v.lines[v.r]; const at = k === 'p' ? Math.min(v.c + 1, l.length) : v.c; v.lines[v.r] = l.slice(0, at) + v.reg + l.slice(at); v.c = at + v.reg.length - 1; }
        });
        v.modified = true; this.clamp(); break;
      }
      case 'u': { const s = v.undo.pop(); if (s) { v.redo.push({ lines: v.lines.slice(), r: v.r, c: v.c }); v.lines = s.lines; v.r = s.r; v.c = s.c; v.modified = this.text() !== v.savedText; this.setMsg('1 change; before #' + (v.undo.length + 1)); } else this.setMsg('Already at oldest change'); this.clamp(); break; }
      case 'i': this.snapshot(); v.mode = 'insert'; break;
      case 'I': this.snapshot(); v.mode = 'insert'; v.c = this.indentOf(v.lines[v.r]).length; break;
      case 'a': this.snapshot(); v.mode = 'insert'; if (v.lines[v.r].length) v.c++; break;
      case 'A': this.snapshot(); v.mode = 'insert'; v.c = v.lines[v.r].length; break;
      case 'o': { this.snapshot(); const ind = this.indentOf(v.lines[v.r]); v.lines.splice(v.r + 1, 0, ind); v.r++; v.c = ind.length; v.mode = 'insert'; v.modified = true; break; }
      case 'O': { this.snapshot(); const ind = this.indentOf(v.lines[v.r]); v.lines.splice(v.r, 0, ind); v.c = ind.length; v.mode = 'insert'; v.modified = true; break; }
      case 's': this.snapshot(); { const l = v.lines[v.r]; v.lines[v.r] = l.slice(0, v.c) + l.slice(v.c + 1); v.mode = 'insert'; v.modified = true; } break;
      case ':': v.mode = 'cmd'; v.cmdline = ''; break;
      case '/': v.mode = 'search'; v.searchDir = 1; v.cmdline = ''; break;
      case '?': v.mode = 'search'; v.searchDir = -1; v.cmdline = ''; break;
      case 'n': this.doSearch(v.searchDir); break;
      case 'N': this.doSearch(-v.searchDir); break;
      case '*': { const m = v.lines[v.r].slice(v.c).match(/\w+/); if (m) { v.search = '\\b' + m[0] + '\\b'; this.doSearch(1); } break; }
      case 'Escape': break;
      case 'PageDown': v.r = Math.min(v.lines.length - 1, v.r + 20); this.clamp(); break;
      case 'PageUp': v.r = Math.max(0, v.r - 20); this.clamp(); break;
      default:
        if (e.ctrlKey && k === 'r') { const s = v.redo.pop(); if (s) { v.undo.push({ lines: v.lines.slice(), r: v.r, c: v.c }); v.lines = s.lines; v.r = s.r; v.c = s.c; v.modified = this.text() !== v.savedText; } this.clamp(); }
        else if (e.ctrlKey && k === 'd') { v.r = Math.min(v.lines.length - 1, v.r + 10); this.clamp(); }
        else if (e.ctrlKey && k === 'u') { v.r = Math.max(0, v.r - 10); this.clamp(); }
        else if (e.ctrlKey && k === 'c') { this.setMsg('Type  :qa!  and press <Enter> to abandon all changes and exit Vim'); }
    }
    this.render();
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
      const extra = /:\s*$/.test(before) || /^\s*-\s*$/.test(before) ? '' : '';
      v.lines.splice(v.r, 1, before, ind + extra + after.replace(/^\s+/, ''));
      v.r++; v.c = ind.length + extra.length; v.modified = true; return;
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
    if (k.length === 1 && !e.ctrlKey && !e.metaKey) { const l = v.lines[v.r]; v.lines[v.r] = l.slice(0, v.c) + k + l.slice(v.c); v.c++; v.modified = true; }
  }

  /* Paste from the browser clipboard (Cmd/Ctrl+V) while in insert mode. */
  pasteText(text) {
    const v = this.v;
    if (!v || v.mode !== 'insert') return;
    this.snapshot();
    const parts = text.replace(/\r/g, '').split('\n');
    const l = v.lines[v.r];
    const before = l.slice(0, v.c), after = l.slice(v.c);
    if (parts.length === 1) { v.lines[v.r] = before + parts[0] + after; v.c += parts[0].length; }
    else { v.lines.splice(v.r, 1, before + parts[0], ...parts.slice(1, -1), parts[parts.length - 1] + after); v.r += parts.length - 1; v.c = parts[parts.length - 1].length; }
    v.modified = true;
    this.render();
  }
}
