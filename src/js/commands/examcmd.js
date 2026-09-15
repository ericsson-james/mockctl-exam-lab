/* commands/examcmd.js — the exam command: progress, questions, instant
   checks, ending, and loading other exam environments by UUID or code. */

registry.register({
  name: 'exam', usage: 'exam [status | question <n> | solution <n> | check [n] | end | list | switch <number|name> | import <code> | export]',
  desc: 'exam progress, questions, and grading', interactive: true,
  async run(ctx, args, io) {
    const app = ctx.app;
    const exam = app.exam;
    const sub = args[0] || 'status';
    const store = app.envStore;

    if (sub === 'status') {
      io.out(exam.name + '  (' + exam.type + ')', 'amber');
      const ms = exam.timeLeftMs();
      io.out('  time left: ' + Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's' + (exam.ended ? ' (exam ended)' : ''));
      io.out('  questions: ' + exam.questions.length + ', passing score ' + exam.passPercent + '%');
      const rows = exam.questions.map(q => { const r = exam.results.get(q.id); return ['  ' + q.id, q.weight + '%', (q.title || '').slice(0, 44), r ? (r.pass ? 'pass' : 'not yet') : '-', exam.flagged.has(q.id) ? 'flagged' : '']; });
      io.out(Printers.table(['  #', 'WEIGHT', 'TASK', 'CHECKED', ''], rows));
      io.out("'exam question N' shows a task; 'exam solution N' explains it; 'exam check N' grades it; 'exam end' finishes.", 'dim');
      return;
    }
    if (sub === 'question' || sub === 'q') {
      const q = exam.question(args[1] || exam.current);
      if (!q) return io.err('exam: no question ' + args[1]);
      exam.select(q.id);
      io.out('Question ' + q.id + '  [' + q.weight + '%]  ' + (q.title || ''), 'amber');
      if (q.context) io.out('  Set configuration context:  kubectl config use-context ' + q.context, 'teal');
      if (q.ssh) io.out('  Nodes: ' + q.ssh, 'teal');
      io.out('');
      io.out(q.text.replace(/`/g, ''));
      return;
    }
    if (sub === 'solution' || sub === 'answer') {
      const q = exam.question(args[1] || exam.current);
      if (!q) return io.err('exam: no question ' + args[1]);
      exam.reveal(q.id);
      io.out('Question ' + q.id + ' — intended solution  (' + (q.title || '') + ')', 'amber');
      io.out('');
      io.out((q.solution || 'No solution text for this question.').replace(/`/g, ''));
      if (q.references && q.references.length) {
        io.out('');
        io.out('Read more:', 'teal');
        for (const r of q.references) io.out('  ' + r.title + '  ' + r.url, 'dim');
      }
      return;
    }
    if (sub === 'check') {
      const ids = args[1] ? [Number(args[1])] : exam.questions.map(q => q.id);
      for (const id of ids) {
        const q = exam.question(id);
        if (!q) { io.err('exam: no question ' + id); continue; }
        const r = exam.check(id);
        if (r.pass) io.out('Question ' + id + ': PASS  (' + (q.title || '') + ')', 'teal');
        else { io.out('Question ' + id + ': not yet  (' + (q.title || '') + ')', 'amber'); for (const f of r.failures) io.out('    - ' + f.hint + (f.detail && f.detail !== f.hint ? '  [' + f.detail + ']' : ''), 'dim'); }
      }
      return;
    }
    if (sub === 'end') {
      const g = exam.end();
      io.out((g.pass ? 'PASS' : 'FAIL') + ' — ' + g.percent + '%  (' + g.earned + '/' + g.total + ' points, passing score ' + exam.passPercent + '%)', g.pass ? 'teal' : 'err');
      for (const r of g.rows) io.out('  ' + String(r.id).padStart(2) + '  ' + (r.pass ? '✓' : '✗') + '  ' + (r.weight + '%').padStart(4) + '  ' + (r.title || ''));
      app.ui.showResults();
      return;
    }
    if (sub === 'list') {
      io.out('Available exams — load one with: exam switch <number>', 'dim');
      app.examOptions().forEach((o, i) => io.out('  ' + (i + 1) + ')  ' + o + (store.entries()[i].cfg === exam.spec ? '   <- current' : '')));
      return;
    }
    if (sub === 'switch') {
      if (!args[1]) return io.err('usage: exam switch <number|name>');
      const cfg = app.examByRef(args[1]);
      if (!cfg) return io.err("exam: no exam '" + args[1] + "' — see 'exam list'");
      const answer = await ctx.term.readLine({ prompt: '<span class="dim">This discards the current exam state. Switch? [y/N]</span> ' });
      if (!answer || !/^y(es)?$/i.test(answer.trim())) return io.out('Cancelled.', 'dim');
      app.requestSwitch(cfg);
      return;
    }
    if (sub === 'import') {
      if (!args[1]) return io.err('usage: exam import <code>');
      const json = decodeCode('OSK1.', args[1]);
      if (json === null) return io.err('exam: not a valid exam code (expected OSK1.…)');
      let cfg;
      try { cfg = JSON.parse(json); } catch (e) { return io.err('exam: code contains invalid JSON: ' + e.message); }
      const errors = ExamSpec.validate(cfg);
      if (errors.length) { io.err('exam: config has problems:'); for (const er of errors) io.err('  ' + er); return; }
      const saved = store.register(cfg);
      io.out('Imported \'' + cfg.name + '\'' + (saved ? ' — it is now in the exam list in this browser.' : ' — browser storage unavailable; it stays in the list for this visit only.'), 'teal');
      io.out("Load it now with: exam switch " + store.entries().length, 'dim');
      return;
    }
    if (sub === 'export') {
      io.out('Exam code for \'' + exam.name + '\' — import with \'exam import <code>\':', 'dim');
      io.out(encodeCode('OSK1.', JSON.stringify(exam.spec)));
      return;
    }
    io.err("exam: unknown subcommand '" + sub + "' — try: status, question N, solution N, check [N], end, list, switch, import, export");
  },
});

/* Minimal structural validation for imported exam specs. */
const ExamSpec = {
  validate(cfg) {
    const errors = [];
    if (!cfg || typeof cfg !== 'object') return ['config must be a JSON object'];
    if (!UUID_RE.test(cfg.uuid || '')) errors.push('missing or invalid "uuid"');
    if (!cfg.name) errors.push('missing "name"');
    if (!cfg.clusters || typeof cfg.clusters !== 'object' || !Object.keys(cfg.clusters).length) errors.push('"clusters" must be a non-empty object');
    else for (const [n, c] of Object.entries(cfg.clusters)) {
      if (!Array.isArray(c.nodes) || !c.nodes.length) errors.push('cluster "' + n + '" needs a "nodes" array');
      else if (!c.nodes.some(x => (x.roles || []).includes('control-plane'))) errors.push('cluster "' + n + '" needs a control-plane node');
      for (const x of c.nodes || []) if (!x.name || !x.ip) errors.push('cluster "' + n + '": every node needs name and ip');
    }
    if (!Array.isArray(cfg.questions) || !cfg.questions.length) errors.push('"questions" must be a non-empty array');
    else cfg.questions.forEach((q, i) => {
      if (!q.text) errors.push('question ' + (i + 1) + ': missing "text"');
      if (q.weight !== undefined && !(Number.isFinite(Number(q.weight)) && Number(q.weight) >= 0)) errors.push('question ' + (i + 1) + ': "weight" must be a non-negative number');
      if (q.references !== undefined && (!Array.isArray(q.references) || q.references.some(r => !r || typeof r !== 'object' || !/^https?:\/\//i.test(String(r.url || ''))))) errors.push('question ' + (i + 1) + ': every reference needs an http(s) "url"');
      if (!Array.isArray(q.checks) || !q.checks.length) errors.push('question ' + (i + 1) + ': needs at least one check');
      else for (const c of q.checks) if (!Checks.types[c.type]) errors.push('question ' + (i + 1) + ': unknown check type "' + c.type + '"');
    });
    return errors;
  },
};
