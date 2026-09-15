/* shell.js — the session stack and command execution: `VAR=val cmd`,
   pipelines, redirection, `&&` / `;` chains, aliases, sudo (runAs), and
   tab completion including kubectl verbs and resource names. */

class Shell {
  constructor(app) {
    this.app = app;
    this.stack = [];
    this.aliases = { k: 'kubectl', vi: 'vim', ll: 'ls -l', la: 'ls -la' };
  }

  get session() { return this.stack[this.stack.length - 1] || null; }
  push(session) { this.stack.push(session); }
  pop() { return this.stack.pop(); }

  ps1() {
    const s = this.session;
    return '<span class="u">' + esc(s.user.name) + '@' + esc(s.host.hostname) + '</span>:<span class="p">' + esc(s.displayCwd()) + '</span>' + (s.user.admin ? '#' : '$') + ' ';
  }

  ctx() {
    return { app: this.app, shell: this, term: this.app.term, world: this.app.world, session: this.session };
  }

  /* Run a whole line: split on ; and && first. */
  async execute(line) {
    const term = this.app.term;
    const t = tokenize(line);
    if (t.error) { term.print('bash: syntax error: ' + t.error, 'err'); return false; }
    const chains = [];
    let cur = [], op = null;
    for (const tok of t.tokens) {
      if (tok === '&&' || tok === ';') { chains.push({ tokens: cur, next: tok }); cur = []; continue; }
      cur.push(tok);
    }
    chains.push({ tokens: cur, next: null });
    let ok = true;
    for (let i = 0; i < chains.length; i++) {
      const c = chains[i];
      if (!c.tokens.length) continue;
      const prev = i > 0 ? chains[i - 1] : null;
      if (prev && prev.next === '&&' && !ok) continue;
      ok = await this.executePipeline(c.tokens);
    }
    return ok;
  }

  async runAs(session, line) {
    this.push(session);
    try { return await this.execute(line); }
    finally { const idx = this.stack.lastIndexOf(session); if (idx !== -1) this.stack.splice(idx, 1); }
  }

  /* One pipeline with optional trailing redirection. Returns success. */
  async executePipeline(tokens) {
    const term = this.app.term;
    let redirect = null;
    const ri = tokens.findIndex(tok => tok === '>' || tok === '>>');
    if (ri !== -1) {
      if (ri !== tokens.length - 2 || tokens[ri + 1] === '|') { term.print('bash: syntax error near unexpected token `' + tokens[ri] + '\'', 'err'); return false; }
      redirect = { append: tokens[ri] === '>>', target: tokens[ri + 1] };
      tokens = tokens.slice(0, ri);
      if (!tokens.length) { term.print('bash: syntax error near unexpected token `newline\'', 'err'); return false; }
    }
    const segments = [];
    let seg = [];
    for (const tok of tokens) { if (tok === '|') { segments.push(seg); seg = []; } else seg.push(tok); }
    segments.push(seg);
    if (segments.some(s => !s.length)) { term.print('bash: syntax error near unexpected token `|\'', 'err'); return false; }

    let stdin = null, failed = false;
    for (let i = 0; i < segments.length; i++) {
      let argv = segments[i].slice();
      // leading VAR=value assignments
      const env = {};
      while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) { const [k, ...v] = argv.shift().split('='); env[k] = v.join('='); }
      if (!argv.length) { Object.assign(this.session.env, env); continue; }
      // $VAR / ${VAR} expansion (a token that is exactly one variable is word-split like bash)
      const envNow = Object.assign({}, this.session.env, env);
      argv = argv.flatMap(tok => {
        const whole = tok.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
        if (whole) return (envNow[whole[1]] || '').split(/\s+/).filter(Boolean);
        return [tok.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, k) => envNow[k] !== undefined ? envNow[k] : m)];
      });
      if (!argv.length) continue;
      // aliases (one level)
      if (this.aliases[argv[0]]) { const t = tokenize(this.aliases[argv[0]]); argv = (t.tokens || [argv[0]]).concat(argv.slice(1)); }
      const [name, ...args] = argv;
      const cmd = registry.get(name);
      if (!cmd) { term.print('bash: ' + name + ': command not found', 'err'); return false; }
      const collect = i < segments.length - 1 || !!redirect;
      if (cmd.interactive && collect) { term.print(name + ': cannot be used in a pipeline or redirection', 'err'); return false; }
      const captured = [];
      const io = {
        collect, stdin,
        out: (text, cls) => { if (collect) String(text).split('\n').forEach(l => captured.push(l)); else term.print(text, cls); },
        err: (text) => { failed = true; if (text !== '') term.print(text, 'err'); },
      };
      const session = this.session;
      const savedEnv = Object.keys(env).length ? Object.assign({}, session.env) : null;
      if (savedEnv) Object.assign(session.env, env);
      try {
        await cmd.run(this.ctx(), args, io);
      } catch (e) {
        if (e instanceof ShellError) { if (e.message !== '') term.print((e instanceof RawError ? '' : cmd.name + ': ') + e.message, 'err'); failed = true; }
        else throw e;
      } finally {
        if (savedEnv) session.env = savedEnv;
      }
      stdin = captured;
    }
    if (redirect) {
      const s = this.session;
      try { s.fs.writeFile(s.resolvePath(redirect.target), stdin.length ? stdin.join('\n') + '\n' : '', s.user, { append: redirect.append }); }
      catch (e) { if (e instanceof ShellError) { term.print('bash: ' + e.message, 'err'); return false; } throw e; }
    }
    return !failed;
  }

  /* ---------- tab completion ---------- */
  completer(input) {
    const term = this.app.term;
    const s = this.session;
    const value = input.value;
    const lastSpace = Math.max(value.lastIndexOf(' '), value.lastIndexOf('\t'));
    const head = value.slice(0, lastSpace + 1);
    const frag = value.slice(lastSpace + 1);
    const words = value.slice(0, lastSpace + 1).trim().split(/\s+/).filter(Boolean);
    let candidates = [];
    if (lastSpace === -1) {
      candidates = [...new Set([...registry.names(), ...Object.keys(this.aliases)])].filter(n => n.startsWith(frag)).sort().map(n => n + ' ');
    } else if (words[0] === 'kubectl' || words[0] === 'k') {
      candidates = this.kubectlCompletions(words.slice(1), frag);
      if (candidates === null) candidates = this.pathCompletions(frag);
    } else {
      candidates = this.pathCompletions(frag);
    }
    if (!candidates || !candidates.length) return;
    if (candidates.length === 1) { input.value = head + candidates[0]; return; }
    let prefix = candidates[0];
    for (const c of candidates) { let i = 0; while (i < prefix.length && i < c.length && prefix[i] === c[i]) i++; prefix = prefix.slice(0, i); }
    if (prefix.length > frag.length) { input.value = head + prefix; return; }
    term.printHtml(this.ps1() + esc(value));
    term.print(candidates.map(c => c.trim()).join('  '));
  }

  pathCompletions(frag) {
    const s = this.session;
    const slash = frag.lastIndexOf('/');
    const dirPart = slash === -1 ? '' : frag.slice(0, slash + 1);
    const base = slash === -1 ? frag : frag.slice(slash + 1);
    let dirNode;
    try { dirNode = s.fs.node(s.resolvePath(dirPart || '.'), s.user); } catch (e) { return []; }
    if (!dirNode || !dirNode.isDir || !dirNode.allows(s.user, 'r')) return [];
    return dirNode.names().filter(n => n.startsWith(base) && (base.startsWith('.') || !n.startsWith('.'))).map(n => dirPart + n + (dirNode.get(n).isDir ? '/' : ' '));
  }

  kubectlCompletions(words, frag) {
    const verbs = ['get', 'describe', 'create', 'apply', 'delete', 'run', 'expose', 'scale', 'autoscale', 'set', 'rollout', 'label', 'annotate', 'taint', 'cordon', 'uncordon', 'drain', 'logs', 'exec', 'top', 'config', 'edit', 'explain', 'api-resources', 'api-versions', 'version', 'cluster-info', 'auth', 'patch', 'replace', 'wait', 'events'];
    const nonFlag = words.filter(w => !w.startsWith('-'));
    if (frag.startsWith('-')) return null;
    if (!nonFlag.length) return verbs.filter(v => v.startsWith(frag)).map(v => v + ' ');
    const verb = nonFlag[0];
    if (verb === 'config') return ['get-contexts', 'use-context', 'current-context', 'set-context', 'view'].filter(v => v.startsWith(frag)).map(v => v + ' ');
    if (verb === 'rollout') { if (nonFlag.length === 1) return ['status', 'history', 'undo', 'restart', 'pause', 'resume'].filter(v => v.startsWith(frag)).map(v => v + ' '); }
    if (verb === 'create' && nonFlag.length === 1) return ['deployment', 'namespace', 'service', 'configmap', 'secret', 'serviceaccount', 'role', 'rolebinding', 'clusterrole', 'clusterrolebinding', 'job', 'cronjob', 'ingress', 'quota', 'priorityclass'].filter(v => v.startsWith(frag)).map(v => v + ' ');
    let cluster, ns = 'default';
    try {
      const kc = this.session.host.kubeconfig;
      if (!kc) return null;
      const c = kc.contexts[kc.current];
      cluster = this.app.world.clusters.get(c.cluster);
      ns = c.namespace || 'default';
      const ni = words.findIndex(w => w === '-n' || w === '--namespace');
      if (ni !== -1 && words[ni + 1]) ns = words[ni + 1];
      const nEq = words.find(w => w.startsWith('--namespace=') || /^-n[^\s]/.test(w));
      if (nEq) ns = nEq.replace(/^--namespace=|^-n/, '');
    } catch (e) { return null; }
    if (!cluster) return null;
    const resourceVerbs = ['get', 'describe', 'delete', 'edit', 'scale', 'expose', 'label', 'annotate', 'logs', 'exec', 'top', 'patch', 'rollout', 'wait', 'set', 'autoscale', 'explain'];
    const rIdx = verb === 'rollout' || verb === 'set' ? 2 : 1;
    if (resourceVerbs.includes(verb) && nonFlag.length === rIdx) {
      if (verb === 'logs' || verb === 'exec') return cluster.list(cluster.kinds.resolve('pod'), ns).map(p => p.metadata.name).filter(n => n.startsWith(frag)).map(n => n + ' ');
      if (frag.includes('/')) { const [k, part] = frag.split('/'); const e = cluster.kinds.resolve(k); if (!e) return []; return cluster.list(e, ns).map(o => k + '/' + o.metadata.name).filter(n => n.startsWith(frag)).map(n => n + ' '); }
      return [...new Set(cluster.kinds.list().flatMap(k => [k.plural, ...k.short]))].filter(n => n.startsWith(frag)).sort().map(n => n + ' ');
    }
    if (resourceVerbs.includes(verb) && nonFlag.length > rIdx) {
      const e = cluster.kinds.resolve(nonFlag[rIdx]);
      if (!e) return null;
      return cluster.list(e, e.namespaced ? ns : null).map(o => o.metadata.name).filter(n => n.startsWith(frag)).map(n => n + ' ');
    }
    if (verb === 'cordon' || verb === 'uncordon' || verb === 'drain' || (verb === 'taint' && nonFlag.length >= 2)) return cluster.nodes().map(n => n.metadata.name).filter(n => n.startsWith(frag)).map(n => n + ' ');
    if (verb === 'taint' && nonFlag.length === 1) return ['nodes '].filter(n => n.startsWith(frag));
    return null;
  }
}
