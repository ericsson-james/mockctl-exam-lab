/* terminal.js — the screen and keyboard. readLine() is promise-based so
   commands like ssh can prompt mid-execution. While the editor is open the
   terminal is suspended and keystrokes go to the editor instead. */

class Terminal {
  constructor() {
    this.termEl = document.getElementById('term');
    this.outEl = document.getElementById('out');
    this.ps1El = document.getElementById('ps1');
    this.cmdEl = document.getElementById('cmd');
    this.pending = null;
    this.suspended = false;
    this.history = [];
    this.histIdx = -1;
    this.histDraft = '';
    this.cmdEl.addEventListener('keydown', (e) => this.onKey(e));
    this.pasteQueue = null;
    this.cmdEl.addEventListener('paste', (e) => this.onPaste(e));
    this.termEl.addEventListener('mouseup', () => {
      if (this.suspended) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) this.cmdEl.focus({ preventScroll: true });
    });
  }

  print(text, cls) {
    const div = document.createElement('div');
    if (cls) div.innerHTML = '<span class="' + cls + '">' + esc(text) + '</span>';
    else div.textContent = text;
    this.outEl.appendChild(div);
    this.scroll();
  }
  printHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    this.outEl.appendChild(div);
    this.scroll();
  }
  clear() { this.outEl.innerHTML = ''; }
  scroll() { this.termEl.scrollTop = this.termEl.scrollHeight; }
  focus() { if (!this.suspended) { this.cmdEl.focus({ preventScroll: true }); this.scroll(); } }

  readLine({ prompt, mask = false, useHistory = false, completer = null }) {
    this.ps1El.innerHTML = prompt;
    this.cmdEl.type = mask ? 'password' : 'text';
    this.focus();
    this.scroll();
    return new Promise((resolve) => {
      this.pending = { resolve, prompt, mask, useHistory, completer };
      if (this.pasteQueue) setTimeout(() => this.drainPaste(), 0);
    });
  }

  /* Enter at the prompt: remember the line and hand it to whoever is waiting. */
  submit() {
    const p = this.pending;
    if (!p || p.choice) return;
    const v = this.cmdEl.value;
    if (p.useHistory && v.trim() && this.history[this.history.length - 1] !== v.trim()) this.history.push(v.trim());
    this.finishRead(v);
  }

  /* A multi-line paste at the prompt runs each complete line in turn, the way a
     terminal does; text after the last newline is left in the input to edit. */
  onPaste(e) {
    if (this.suspended || !this.pending || this.pending.choice) return;
    const text = ((e.clipboardData || window.clipboardData) && (e.clipboardData || window.clipboardData).getData('text')) || '';
    if (!text.includes('\n')) return;
    e.preventDefault();
    const input = this.cmdEl;
    const lines = text.replace(/\r/g, '').split('\n');
    const tail = lines.pop();
    const first = lines.shift();
    const start = input.selectionStart === undefined || input.selectionStart === null ? input.value.length : input.selectionStart;
    const end = input.selectionEnd === undefined || input.selectionEnd === null ? input.value.length : input.selectionEnd;
    const before = input.value.slice(0, start), after = input.value.slice(end);
    this.pasteQueue = { lines, tail: tail + after };
    input.value = before + first;
    this.submit();
  }
  drainPaste() {
    const q = this.pasteQueue;
    if (!q || !this.pending || this.pending.choice || this.suspended) return;
    if (q.lines.length) { this.cmdEl.value = q.lines.shift(); this.submit(); return; }
    this.cmdEl.value = q.tail || '';
    this.pasteQueue = null;
    try { this.cmdEl.setSelectionRange(this.cmdEl.value.length, this.cmdEl.value.length); } catch (err) { /* stub */ }
  }

  /* Show a numbered menu; resolves with the chosen index (or null on Ctrl+C).
     Arrow keys move the highlight, Enter picks it, or type a number. */
  readChoice({ prompt, options }) {
    const div = document.createElement('div');
    div.className = 'choices';
    this.outEl.appendChild(div);
    const state = { idx: 0 };
    const render = () => {
      div.innerHTML = options.map((o, i) => '<div class="choice' + (i === state.idx ? ' active' : '') + '">' + (i === state.idx ? '▸ ' : '  ') + (i + 1) + ')  ' + esc(o) + '</div>').join('');
    };
    render();
    this.ps1El.innerHTML = prompt;
    this.cmdEl.type = 'text';
    this.focus();
    this.scroll();
    return new Promise((resolve) => {
      this.pending = { resolve, prompt, mask: false, useHistory: false, completer: null, choice: { options, state, render } };
    });
  }

  finishRead(value, suffix) {
    const p = this.pending;
    this.pending = null;
    this.histIdx = -1;
    this.printHtml(p.prompt + esc(p.mask ? '' : this.cmdEl.value) + (suffix || ''));
    this.cmdEl.value = '';
    this.cmdEl.type = 'text';
    this.ps1El.innerHTML = '';
    p.resolve(value);
  }

  onKey(e) {
    if (this.suspended) return;
    const p = this.pending;
    if (!p) { if (e.key !== 'F5' && !e.metaKey) e.preventDefault(); return; }
    const input = this.cmdEl;
    if (p.choice) {
      const { options, state, render } = p.choice;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        state.idx = (state.idx + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
        input.value = String(state.idx + 1);
        render();
        return;
      }
      if (e.key === 'Enter') {
        const v = input.value.trim();
        const idx = v === '' ? state.idx : parseInt(v, 10) - 1;
        if (!(idx >= 0 && idx < options.length)) {
          this.print('Enter a number between 1 and ' + options.length + ', or use the arrow keys.', 'err');
          input.value = '';
          return;
        }
        state.idx = idx; render();
        input.value = options[idx];
        this.finishRead(idx);
        return;
      }
      if (e.key === 'c' && e.ctrlKey) { e.preventDefault(); this.finishRead(null, '^C'); return; }
      if (/^\d$/.test(e.key)) {
        const n = parseInt(input.value + e.key, 10);
        if (n >= 1 && n <= options.length) { state.idx = n - 1; render(); }
      }
      return;
    }
    if (e.key === 'Enter') {
      this.submit();
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      this.finishRead(null, '^C');
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      this.clear();
    } else if (e.key === 'u' && e.ctrlKey) {
      e.preventDefault();
      input.value = '';
    } else if (e.key === 'ArrowUp' && p.useHistory) {
      e.preventDefault();
      if (!this.history.length) return;
      if (this.histIdx === -1) { this.histDraft = input.value; this.histIdx = this.history.length; }
      if (this.histIdx > 0) this.histIdx--;
      input.value = this.history[this.histIdx] || '';
      requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length));
    } else if (e.key === 'ArrowDown' && p.useHistory) {
      e.preventDefault();
      if (this.histIdx === -1) return;
      this.histIdx++;
      if (this.histIdx >= this.history.length) { this.histIdx = -1; input.value = this.histDraft; }
      else input.value = this.history[this.histIdx];
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (p.completer) p.completer(input);
    }
  }
}
