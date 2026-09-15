/* commands/perms.js — the permissions surface: chmod, chown, whoami, id, su. */

registry.register({
  name: 'chmod', usage: 'chmod <mode> <path>...', desc: 'change permissions (numeric, e.g. chmod 600 secret.txt)',
  run(ctx, args, io) {
    if (args.length < 2) return io.err('usage: chmod <mode> <path>   (numeric modes only, e.g. 644, 755, 600)');
    const modeStr = args[0];
    if (!/^[0-7]{3}$/.test(modeStr)) return io.err('chmod: invalid mode: \'' + modeStr + '\' (use 3 octal digits, e.g. 644)');
    const s = ctx.session;
    for (const target of args.slice(1)) {
      try { s.fs.chmod(s.resolvePath(target), parseInt(modeStr, 8), s.user); }
      catch (e) { if (e instanceof ShellError) io.err('chmod: ' + e.message); else throw e; }
    }
  },
});

registry.register({
  name: 'chown', usage: 'chown <user> <path>...', desc: 'change a file\'s owner (root only)',
  run(ctx, args, io) {
    if (args.length < 2) return io.err('usage: chown <user> <path>');
    const s = ctx.session;
    if (!s.host.getUser(args[0])) return io.err('chown: invalid user: \'' + args[0] + '\'');
    for (const target of args.slice(1)) {
      try { s.fs.chown(s.resolvePath(target), args[0], s.user); }
      catch (e) { if (e instanceof ShellError) io.err('chown: ' + e.message); else throw e; }
    }
  },
});

registry.register({
  name: 'whoami', usage: 'whoami', desc: 'print your username',
  run(ctx, args, io) { io.out(ctx.session.user.name); },
});

registry.register({
  name: 'id', usage: 'id [user]', desc: 'print user identity',
  run(ctx, args, io) {
    const s = ctx.session;
    const u = args[0] ? s.host.getUser(args[0]) : s.user;
    if (!u) return io.err('id: \'' + args[0] + '\': no such user');
    io.out('uid=' + u.uid + '(' + u.name + ')' + (u.admin ? ' — administrator' : ''));
  },
});

registry.register({
  name: 'su', usage: 'su [user]', desc: 'switch user on this host (exit returns)',
  interactive: true,
  async run(ctx, args, io) {
    const s = ctx.session;
    const name = args[0] || 'root';
    const target = s.host.getUser(name);
    // Prompt even for unknown users so name probing isn't free.
    if (!target || target.password !== null) {
      if (!(s.user.admin && target)) {   // root switches without a password
        const pw = await ctx.term.readLine({ prompt: 'Password: ', mask: true });
        if (pw === null) return;
        if (!target || !target.authenticate(pw)) return io.err('su: Authentication failure');
      }
    }
    ctx.shell.push(new Session(s.host, target));
  },
});
