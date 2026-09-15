/* exam/ui.js — the question panel beside the terminal: timer, question
   navigator, task text with the context line, check/flag controls, and
   the results screen. Pure DOM, no framework. */

class ExamUI {
  constructor(app) {
    this.app = app;
    this.panel = document.getElementById('examPanel');
    this.timerEl = document.getElementById('examTimer');
    this.titleEl = document.getElementById('examTitle');
    this.navEl = document.getElementById('examNav');
    this.bodyEl = document.getElementById('examBody');
    this.overlay = document.getElementById('examOverlay');
    this.endBtn = document.getElementById('examEnd');
    this.exam = null;
    this.timer = null;
    this.solOverlay = document.getElementById('solutionOverlay');
    this.solTitle = document.getElementById('solutionTitle');
    this.solBody = document.getElementById('solutionBody');
    this.endBtn.addEventListener('click', () => this.confirmEnd());
    document.getElementById('examOverlayClose').addEventListener('click', () => { this.overlay.hidden = true; this.app.term.focus(); });
    document.getElementById('solutionClose').addEventListener('click', () => this.closeSolution());
    this.solOverlay.addEventListener('click', (e) => { if (e.target === this.solOverlay) this.closeSolution(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!this.solOverlay.hidden) { e.preventDefault(); this.closeSolution(); }
      else if (!this.overlay.hidden) { e.preventDefault(); this.overlay.hidden = true; this.app.term.focus(); }
    });
  }

  showSolution(q) {
    this.exam.reveal(q.id);
    this.solTitle.textContent = 'Question ' + q.id + ' — intended solution' + (q.title ? ': ' + q.title : '');
    this.solBody.innerHTML = this.solutionHtml(q);
    this.solOverlay.hidden = false;
    document.getElementById('solutionClose').focus();
  }
  closeSolution() {
    this.solOverlay.hidden = true;
    this.app.term.focus();
  }

  attach(exam) {
    this.exam = exam;
    exam.onChange(() => this.render());
    this.titleEl.textContent = exam.name;
    this.panel.hidden = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
    this.render();
  }

  tick() {
    if (!this.exam) return;
    const ms = this.exam.timeLeftMs();
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    this.timerEl.textContent = (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    this.timerEl.classList.toggle('warn', ms < 10 * 60000 && !this.exam.ended);
    if (ms === 0 && !this.exam.ended) { this.exam.end(); this.showResults('Time is up.'); }
  }

  /* Lightweight markdown: blank-line paragraphs, "- " lists, "1. " lists,
     four-space-indented lines become <pre> blocks (a run of indented lines
     inside a paragraph is split out on its own). */
  formatText(text) {
    const escd = esc(text);
    const out = [];
    for (const p of escd.split(/\n\s*\n/)) {
      const lines = p.split('\n');
      if (lines.every(l => /^\s*[-*] /.test(l))) { out.push('<ul>' + lines.map(l => '<li>' + this.inline(l.replace(/^\s*[-*] /, '')) + '</li>').join('') + '</ul>'); continue; }
      if (lines.every(l => /^\s*\d+\. /.test(l))) { out.push('<ol>' + lines.map(l => '<li>' + this.inline(l.replace(/^\s*\d+\. /, '')) + '</li>').join('') + '</ol>'); continue; }
      let run = [], runIsCode = null;
      const flush = () => {
        if (!run.length) return;
        out.push(runIsCode ? '<pre>' + run.map(l => l.replace(/^ {4}/, '')).join('\n') + '</pre>' : '<p>' + this.inline(run.join('<br>')) + '</p>');
        run = [];
      };
      for (const l of lines) {
        const isCode = /^ {4}/.test(l);
        if (runIsCode !== null && isCode !== runIsCode) flush();
        runIsCode = isCode;
        run.push(l);
      }
      flush();
    }
    return out.join('');
  }
  inline(s) {
    return s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }

  solutionHtml(q) {
    let html = q.solution ? this.formatText(q.solution) : '<p class="dim">No solution text for this question.</p>';
    // Only http(s) links are rendered; anything else in an imported exam is dropped.
    const refs = (q.references || []).filter(r => r && /^https?:\/\//i.test(String(r.url || '')));
    if (refs.length) {
      html += '<div class="qrefs"><span class="qsolhead">Read more</span><ul>' +
        refs.map(r => '<li><a href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer">' + esc(r.title || r.url) + '</a> <span class="dim">' + esc(String(r.url).replace(/^https?:\/\//i, '').split('/')[0]) + '</span></li>').join('') + '</ul></div>';
    }
    return html;
  }

  render() {
    const exam = this.exam;
    if (!exam) return;
    const q = exam.question(exam.current);
    this.navEl.innerHTML = exam.questions.map(x => {
      const r = exam.results.get(x.id);
      const cls = ['qpill', x.id === exam.current ? 'active' : '', exam.flagged.has(x.id) ? 'flagged' : '', r ? (r.pass ? 'pass' : 'fail') : ''].filter(Boolean).join(' ');
      return '<button class="' + cls + '" data-q="' + x.id + '" title="' + esc(x.title || 'Question ' + x.id) + '">' + x.id + '</button>';
    }).join('');
    for (const b of this.navEl.querySelectorAll('button')) b.addEventListener('click', () => { exam.select(b.dataset.q); this.app.term.focus(); });
    if (!q) return;
    const r = exam.results.get(q.id);
    const ctxLine = q.context ? 'kubectl config use-context ' + q.context : null;
    this.bodyEl.innerHTML =
      '<div class="qhead"><span class="qnum">Question ' + q.id + '</span><span class="qweight">' + q.weight + '%</span>' + (q.domain ? '<span class="qdomain">' + esc(q.domain) + '</span>' : '') + '</div>' +
      (q.title ? '<h2>' + esc(q.title) + '</h2>' : '') +
      (ctxLine ? '<div class="qctx"><span class="qctxlabel">Set configuration context:</span><code>' + esc(ctxLine) + '</code></div>' : '') +
      (q.ssh ? '<div class="qctx"><span class="qctxlabel">You can ssh into the nodes:</span><code>' + esc(q.ssh) + '</code></div>' : '') +
      '<div class="qtext">' + this.formatText(q.text || '') + '</div>' +
      (r ? '<div class="qresult ' + (r.pass ? 'pass' : 'fail') + '">' + (r.pass ? '✓ All checks pass' : '✗ Not yet: <ul>' + r.failures.map(f => '<li>' + esc(f.hint) + (f.detail && f.detail !== f.hint ? ' <span class="dim">(' + esc(f.detail) + ')</span>' : '') + '</li>').join('') + '</ul>') + '</div>' : '') +
      '<div class="qactions">' +
        '<button id="qCheck" class="primary">Check answer</button>' +
        '<button id="qFlag">' + (exam.flagged.has(q.id) ? 'Unflag' : 'Flag for review') + '</button>' +
        '<button id="qSolution">Show solution</button>' +
        '<span class="spacer"></span>' +
        '<button id="qPrev" ' + (q.id <= 1 ? 'disabled' : '') + '>‹ Prev</button>' +
        '<button id="qNext" ' + (q.id >= exam.questions.length ? 'disabled' : '') + '>Next ›</button>' +
      '</div>';
    document.getElementById('qCheck').addEventListener('click', () => { exam.check(q.id); this.app.term.focus(); });
    document.getElementById('qFlag').addEventListener('click', () => { exam.toggleFlag(q.id); this.app.term.focus(); });
    document.getElementById('qSolution').addEventListener('click', () => this.showSolution(q));
    document.getElementById('qPrev').addEventListener('click', () => { exam.select(q.id - 1); this.app.term.focus(); });
    document.getElementById('qNext').addEventListener('click', () => { exam.select(q.id + 1); this.app.term.focus(); });
    this.endBtn.textContent = exam.ended ? 'Show results' : 'End exam';
  }

  confirmEnd() {
    if (!this.exam) return;
    if (this.exam.ended) return this.showResults();
    const unanswered = this.exam.questions.filter(q => !this.exam.results.get(q.id) || !this.exam.results.get(q.id).pass).length;
    if (!window.confirm('End the exam and grade all ' + this.exam.questions.length + ' questions now?' + (unanswered ? '\n\n' + unanswered + ' question(s) have not been checked as passing.' : ''))) return;
    this.exam.end();
    this.showResults();
  }

  showResults(note) {
    const g = this.exam.lastGrade || this.exam.grade();
    const el = document.getElementById('examResults');
    el.innerHTML =
      '<h1>' + (g.pass ? 'PASS' : 'FAIL') + ' — ' + g.percent + '%</h1>' +
      '<p class="dim">' + esc(this.exam.name) + ' · ' + g.earned + ' of ' + g.total + ' points · passing score ' + this.exam.passPercent + '%' + (note ? ' · ' + esc(note) : '') + (this.exam.revealed.size ? ' · solutions viewed for ' + this.exam.revealed.size + ' question' + (this.exam.revealed.size > 1 ? 's' : '') : '') + '</p>' +
      '<table><thead><tr><th>#</th><th>Task</th><th>Domain</th><th>Weight</th><th>Result</th></tr></thead><tbody>' +
      g.rows.map(r => '<tr class="' + (r.pass ? 'pass' : 'fail') + '"><td>' + r.id + '</td><td>' + esc(r.title || '') + (r.revealed ? ' <span class="dim">(solution viewed)</span>' : '') + (r.failures.length ? '<ul>' + r.failures.map(f => '<li>' + esc(f.hint) + '</li>').join('') + '</ul>' : '') + '</td><td>' + esc(r.domain || '') + '</td><td>' + r.weight + '%</td><td>' + (r.pass ? '✓' : '✗') + '</td></tr>').join('') +
      '</tbody></table>' +
      '<p class="dim">The terminal stays open — you can keep working on tasks and re-check them, or reload the page to start a fresh attempt.</p>';
    this.overlay.hidden = false;
    this.render();
  }
}
