/* app.js — boot: pick an exam by UUID (blank = default), build the world,
   start the exam timer and panel, log the candidate in, run the REPL. */

const DEFAULT_EXAM_UUID = 'c0a80101-0000-4000-8000-0000000c4a01';

class App {
  constructor() {
    this.term = new Terminal();
    this.editor = new Editor(this);
    this.envStore = new EnvironmentStore(BUILTIN_EXAMS);
    this.shell = new Shell(this);
    this.ui = new ExamUI(this);
    this.kubectl = new Kubectl(this);
    this.world = null;
    this.exam = null;
    this.pendingSwitch = null;
    registry.register({ name: 'kubectl', usage: 'kubectl <command> [flags]', desc: 'the Kubernetes CLI', run: (ctx, args, io) => this.kubectl.run(ctx, args, io) });
    document.addEventListener('paste', (e) => {
      if (!this.editor.v) return;
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (text) { e.preventDefault(); this.editor.pasteText(text); }
    });
  }

  /* A phone is a poor place for a terminal. Coarse pointer plus a narrow screen,
     or a mobile user agent; tablets in landscape with a keyboard pass through. */
  looksLikeMobile() {
    try {
      const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
      const narrow = Math.min(window.innerWidth, window.innerHeight) < 768;
      const ua = /Mobi|Android|iPhone|iPod/i.test(navigator.userAgent || '');
      return (coarse && narrow) || ua;
    } catch (e) { return false; }
  }

  /* Show the desktop notice once per tab session; resolves when dismissed. */
  mobileGate() {
    const KEY = 'mockctlMobileOk';
    let dismissed = false;
    try { dismissed = sessionStorage.getItem(KEY) === '1'; } catch (e) { /* storage unavailable */ }
    if (dismissed || !this.looksLikeMobile()) return Promise.resolve();
    const overlay = document.getElementById('mobileOverlay');
    const btn = document.getElementById('mobileContinue');
    overlay.hidden = false;
    return new Promise((resolve) => {
      btn.addEventListener('click', () => {
        overlay.hidden = true;
        try { sessionStorage.setItem(KEY, '1'); } catch (e) { /* ignore */ }
        resolve();
      }, { once: true });
    });
  }

  async start() {
    const term = this.term;
    await this.mobileGate();
    term.print('mockctl exam lab — CKA / CKS practice environment', 'amber');
    term.printHtml('<span class="dim">Simulated clusters, nodes, and tooling. Runs entirely in your browser; no network calls. Independent, unofficial project that is not affiliated with The Linux Foundation or CNCF. For changes, corrections, or other recommendations please reach out to <a href="https://www.linkedin.com/in/james-ericsson/" target="_blank" rel="noopener noreferrer">James Ericsson</a>. Source: <a href="https://github.com/ericsson-james/mockctl-exam-lab" target="_blank" rel="noopener noreferrer">github.com/ericsson-james/mockctl-exam-lab</a>.</span>');
    term.print('');
    const hash = decodeURIComponent((location.hash || '').replace(/^#/, ''));
    let cfg = hash ? this.examByRef(hash) : null;
    if (hash && !cfg) term.print('No exam matches the URL fragment (#' + hash + ') — pick one below.', 'err');
    while (true) {
      if (this.pendingSwitch) { cfg = this.pendingSwitch; this.pendingSwitch = null; }
      if (!cfg) cfg = await this.promptExam();
      this.bootExam(cfg);
      cfg = null;
      await this.runSession();
    }
  }

  examOptions() {
    return this.envStore.entries().map(e => e.cfg.name + '   (' + (e.cfg.exam || 'CKA') + ', ' + (e.cfg.questions || []).length + ' questions, ' + (e.cfg.durationMinutes || 120) + ' min' + (e.builtin ? '' : ', imported') + ')');
  }
  examByRef(ref) {
    const entries = this.envStore.entries();
    if (/^\d+$/.test(ref)) return (entries[parseInt(ref, 10) - 1] || {}).cfg || null;
    return this.envStore.findConfig(ref);
  }

  async promptExam() {
    const term = this.term;
    while (true) {
      term.print('Available exams:', 'amber');
      const idx = await term.readChoice({ prompt: '<span class="dim">Select an exam (↑/↓ then Enter, or type its number):</span> ', options: this.examOptions() });
      if (idx === null) continue;
      return this.envStore.entries()[idx].cfg;
    }
  }

  requestSwitch(cfg) { this.pendingSwitch = cfg; this.shell.stack = []; this.switching = true; }

  bootExam(cfg) {
    this.world = new World(cfg);
    // keep the clusters alive between commands (pods come up, controllers act, jobs finish)
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = setInterval(() => { for (const c of this.world.clusters.values()) { try { Sim.reconcile(c); } catch (e) { /* keep ticking */ } } }, 1500);
    this.exam = new Exam(cfg, this.world);
    this.ui.attach(this.exam);
    this.shell.stack = [];
    this.switching = false;
    const term = this.term;
    term.print('');
    term.print('Exam: ' + this.exam.name + '  (' + this.exam.type + ', ' + this.exam.questions.length + ' questions, ' + Math.round(this.exam.durationMs / 60000) + ' minutes)', 'amber');
    term.print('The clock is running. Questions are in the panel beside the terminal; each names its kubectl context.', 'dim');
    term.print("Type 'help' for how this environment works, 'exam' for progress, 'exam check N' to grade a task.", 'dim');
    term.print("Other exams: 'exam list' and 'exam switch <number>'.", 'dim');
    term.print('');
  }

  /* Honor 'export NAME="value"' and 'alias x=y' lines in ~/.bashrc. */
  sourceBashrc(session) {
    let text = '';
    try { text = session.fs.readFile(session.user.homeParts.concat(['.bashrc']), null); } catch (e) { return; }
    for (const line of text.split('\n')) {
      let m = line.match(/^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) { session.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); continue; }
      m = line.match(/^\s*alias\s+([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/);
      if (m) this.shell.aliases[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }

  async runSession() {
    const term = this.term;
    const base = this.world.base;
    const user = base.getUser(this.world.candidate);
    while (!this.switching) {
      const session = new Session(base, user);
      this.sourceBashrc(session);
      this.shell.push(session);
      while (this.shell.session && !this.switching) {
        const line = await term.readLine({ prompt: this.shell.ps1(), useHistory: true, completer: (input) => this.shell.completer(input) });
        if (line === null || !line.trim()) continue;
        await this.shell.execute(line.trim());
      }
      if (!this.switching) term.print('(logging back in as ' + user.name + '@' + base.hostname + ' — the exam session stays open)', 'dim');
    }
  }
}

const app = new App();
globalThis.__mockctl = app;   // handy for debugging and for the test harness
app.start();
