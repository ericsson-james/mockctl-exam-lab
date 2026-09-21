/* commands/sessioncmds.js — help, man, exit, clear, history, date, env,
   export, alias, which, and the file editors (vim, nano). */

registry.register({ name: 'clear', usage: 'clear', desc: 'clear the screen', run(ctx) { ctx.term.clear(); } });
registry.register({ name: 'history', usage: 'history', desc: 'show past commands', run(ctx, args, io) { ctx.term.history.forEach((h, i) => io.out(String(i + 1).padStart(5) + '  ' + h)); } });
registry.register({ name: 'date', usage: 'date', desc: 'print the current date and time', run(ctx, args, io) { io.out(new Date().toString()); } });
registry.register({ name: 'env', usage: 'env', desc: 'print environment variables', aliases: ['printenv'], run(ctx, args, io) { const e = ctx.session.env; io.out(args[0] ? (e[args[0]] || '') : Object.entries(e).map(([k, v]) => k + '=' + v).join('\n')); } });
registry.register({ name: 'export', usage: 'export VAR=value', desc: 'set an environment variable', run(ctx, args, io) { for (const a of args) { const i = a.indexOf('='); if (i === -1) continue; ctx.session.env[a.slice(0, i)] = a.slice(i + 1); } } });
registry.register({ name: 'unset', usage: 'unset VAR', desc: 'remove an environment variable', run(ctx, args) { for (const a of args) delete ctx.session.env[a]; } });
registry.register({ name: 'alias', usage: 'alias [name=command]', desc: 'show or define aliases', run(ctx, args, io) { if (!args.length) return io.out(Object.entries(ctx.shell.aliases).map(([k, v]) => 'alias ' + k + "='" + v + "'").join('\n')); for (const a of args) { const i = a.indexOf('='); if (i !== -1) ctx.shell.aliases[a.slice(0, i)] = a.slice(i + 1); } } });
registry.register({ name: 'unalias', usage: 'unalias name', desc: 'remove an alias', run(ctx, args) { for (const a of args) delete ctx.shell.aliases[a]; } });
registry.register({ name: 'which', usage: 'which <command>', desc: 'locate a command', run(ctx, args, io) { for (const a of args) { if (registry.get(a)) io.out('/usr/bin/' + a); else io.err(a + ' not found'); } } });
registry.register({ name: 'true', usage: 'true', desc: 'do nothing, successfully', run() {} });
registry.register({ name: 'sleep', usage: 'sleep <seconds>', desc: 'pause for a while', async run(ctx, args) { const s = Math.min(30, parseFloat(args[0]) || 0); await new Promise(r => setTimeout(r, s * 1000)); } });
registry.register({ name: 'watch', usage: 'watch <command>', desc: 'run a command once (watching is not simulated)', async run(ctx, args, io) { const argv = args.filter(a => !a.startsWith('-')); io.out('Every 2.0s: ' + argv.join(' ') + '   (' + ctx.session.host.hostname + ', run once — Ctrl+C would stop a real watch)\n', 'dim'); await ctx.shell.execute(argv.join(' ')); } });

registry.register({
  name: 'exit', usage: 'exit', desc: 'leave this session (ssh/sudo returns; the console logs back in)',
  aliases: ['logout'], interactive: true,
  run(ctx) {
    const left = ctx.shell.pop();
    const now = ctx.shell.session;
    if (!now) { ctx.term.print('logout', 'dim'); return; }
    if (left.host !== now.host) ctx.term.print('Connection to ' + left.host.hostname + ' closed.', 'dim');
  },
});

registry.register({
  name: 'man', usage: 'man <command>', desc: 'show usage for a command',
  run(ctx, args, io) {
    if (!args[0]) return io.err('What manual page do you want?');
    const c = registry.get(args[0]);
    if (!c) return io.err('No manual entry for ' + args[0]);
    io.out(c.name.toUpperCase() + '\n  usage: ' + c.usage + '\n  ' + c.desc);
  },
});

registry.register({
  name: 'help', usage: 'help [command]', desc: 'how this exam environment works',
  run(ctx, args, io) {
    if (args[0]) return registry.get('man').run(ctx, args, io);
    io.out('mockctl exam lab — help', 'amber');
    io.out('');
    io.out('This terminal is your exam workstation. The panel beside it lists the');
    io.out('questions; each one names the kubectl context to use. Everything here is');
    io.out('simulated in your browser — no real clusters, no network calls.');
    io.out('Independent, unofficial project; not affiliated with The Linux Foundation or CNCF.');
    io.out('Source and issues: https://github.com/ericsson-james/mockctl-exam-lab');
    io.out('');
    io.out('Clusters', 'teal');
    io.out('    kubectl config get-contexts        the clusters you have access to');
    io.out('    kubectl config use-context k8s     switch (each question tells you which)');
    io.out('    k                                  alias for kubectl; Tab completes verbs, kinds, names');
    io.out('    kubectl run x --image=nginx $do    $do = --dry-run=client -o yaml (see ~/.bashrc)');
    io.out('');
    io.out('Nodes', 'teal');
    io.out('    ssh cka-control                    log into a node; sudo -i for root; exit to return');
    io.out('    systemctl / journalctl / etcdctl / kubeadm / apt-get   all work on nodes');
    io.out('');
    io.out('Files & editing', 'teal');
    io.out('    vim pod.yaml                       vim: visual mode (v V), d/y/c + motions and text objects (dd ciw di"),');
    io.out('                                       . repeat, u / Ctrl-R, :5,10d, :%s/a/b/g, :g/re/d, :set nu, :help');
    io.out('    paste                              Cmd/Ctrl+V (or Shift+Insert) pastes into vim in any mode, verbatim;');
    io.out('                                       a multi-line paste at the prompt runs line by line');
    io.out('    kubectl edit deploy/web            opens the object in vim; :wq applies it');
    io.out('    kubectl apply -f pod.yaml          files live on the host you are logged into');
    io.out('');
    io.out('Exam', 'teal');
    io.out('    exam                               progress, time left, current question');
    io.out('    exam question 3                    show question 3 in the terminal');
    io.out('    exam check 3                       grade question 3 now (instant feedback)');
    io.out('    exam solution 3                    the intended solution, with links to the docs');
    io.out('    exam end                           finish and see your score');
    io.out('');
    io.out('Not simulated: kubectl port-forward/cp/attach, Helm and Kustomize, interactive shells inside pods', 'dim');
    io.out('(run single commands with kubectl exec pod -- cmd instead).', 'dim');
  },
});

registry.register({
  name: 'vim', usage: 'vim <file>', desc: 'edit a file (vi-style; :wq saves and quits)',
  aliases: ['nano', 'vi'],
  interactive: true,
  async run(ctx, args, io) {
    const s = ctx.session;
    const target = args.filter(a => !a.startsWith('-'))[0];
    let text = '';
    let parts = null;
    if (target) {
      parts = s.resolvePath(target);
      try { text = s.fs.readFile(parts, s.user); }
      catch (e) {
        if (e instanceof ShellError && e.message.includes('Permission denied')) return io.err('"' + target + '" [Permission Denied]');
        if (e instanceof ShellError && e.message.includes('Is a directory')) return io.err('"' + target + '" is a directory');
      }
    }
    const res = await ctx.app.editor.open({
      text, name: target || '[No Name]',
      onSave: (content, newName) => {
        const p = newName ? s.resolvePath(newName) : parts;
        if (!p) return 'E32: No file name';
        try { s.fs.writeFile(p, content, s.user); } catch (e) { return 'E212: Can\'t open file for writing (' + e.message + ')'; }
        parts = p;
        return null;
      },
    });
    if (res.saved && ctx.session.host.node) Sim.reconcile(ctx.session.host.node.cluster);
  },
});
