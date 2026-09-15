/* commands/fsops.js — filesystem commands: ls, cd, pwd, tree, mkdir,
   touch, rm, rmdir, cp, mv. All go through FileSystem, which enforces
   the acting user's permissions. */

registry.register({
  name: 'ls', usage: 'ls [-a] [-l] [path]', desc: 'list directory contents',
  run(ctx, args, io) {
    const { flags, rest } = splitFlags(args);
    const s = ctx.session;
    const target = rest[0] || '.';
    const parts = s.resolvePath(target);
    const node = s.fs.node(parts, s.user);
    if (!node.isDir) {
      if (flags.has('l')) io.out(node.permString() + '  ' + node.owner.padEnd(10) + String(node.size).padStart(6) + '  ' + node.mtimeString() + '  ' + target);
      else io.out(target);
      return;
    }
    if (!node.allows(s.user, 'r')) throw new FsError((pathString(parts) || '/') + ': Permission denied');
    let names = node.names();
    if (!flags.has('a')) names = names.filter(n => !n.startsWith('.'));
    if (flags.has('l')) {
      for (const n of names) {
        const c = node.get(n);
        io.out(c.permString() + '  ' + c.owner.padEnd(10) + String(c.size).padStart(6) + '  ' +
          c.mtimeString() + '  ' + n + (c.isDir ? '/' : ''), c.isDir ? 'teal' : null);
      }
    } else if (io.collect) {
      for (const n of names) io.out(n);
    } else if (names.length) {
      ctx.term.printHtml(names.map(n => node.get(n).isDir
        ? '<span class="teal">' + esc(n) + '/</span>' : esc(n)).join('  '));
    }
  },
});

registry.register({
  name: 'cd', usage: 'cd [path]', desc: 'change the current directory',
  run(ctx, args) {
    const s = ctx.session;
    const parts = s.resolvePath(args[0] || '~');
    const node = s.fs.node(parts, s.user);
    if (!node.isDir) throw new FsError(pathString(parts) + ': Not a directory');
    if (!node.allows(s.user, 'x')) throw new FsError((pathString(parts) || '/') + ': Permission denied');
    s.cwd = parts;
  },
});

registry.register({
  name: 'pwd', usage: 'pwd', desc: 'print the current directory',
  run(ctx, args, io) { io.out(pathString(ctx.session.cwd) || '/'); },
});

registry.register({
  name: 'tree', usage: 'tree [path]', desc: 'show directories as a tree',
  run(ctx, args, io) {
    const s = ctx.session;
    const target = args[0] || '.';
    const node = s.fs.node(s.resolvePath(target), s.user);
    if (!node.isDir) return io.out(target);
    let dirs = 0, files = 0;
    io.out(target === '.' ? '.' : target, 'teal');
    (function walk(n, prefix) {
      if (!n.allows(s.user, 'r')) return;
      const names = n.names().filter(x => !x.startsWith('.'));
      names.forEach((name, i) => {
        const last = i === names.length - 1;
        const child = n.get(name);
        child.isDir ? dirs++ : files++;
        io.out(prefix + (last ? '└── ' : '├── ') + name + (child.isDir ? '/' : ''), child.isDir ? 'teal' : null);
        if (child.isDir && child.allows(s.user, 'x')) walk(child, prefix + (last ? '    ' : '│   '));
      });
    })(node, '');
    io.out('\n' + dirs + ' director' + (dirs === 1 ? 'y' : 'ies') + ', ' + files + ' file' + (files === 1 ? '' : 's'), 'dim');
  },
});

registry.register({
  name: 'mkdir', usage: 'mkdir [-p] <dir>...', desc: 'create directories',
  run(ctx, args, io) {
    const { flags, rest } = splitFlags(args);
    if (!rest.length) return io.err('mkdir: missing operand');
    const s = ctx.session;
    for (const target of rest) {
      try { s.fs.mkdir(s.resolvePath(target), s.user, { parents: flags.has('p') }); }
      catch (e) { if (e instanceof ShellError) io.err('mkdir: ' + e.message); else throw e; }
    }
  },
});

registry.register({
  name: 'touch', usage: 'touch <file>...', desc: 'create empty files',
  run(ctx, args, io) {
    if (!args.length) return io.err('touch: missing file operand');
    const s = ctx.session;
    for (const target of args) {
      try { s.fs.touchFile(s.resolvePath(target), s.user); }
      catch (e) { if (e instanceof ShellError) io.err('touch: ' + e.message); else throw e; }
    }
  },
});

registry.register({
  name: 'rm', usage: 'rm [-r] [-f] <path>...', desc: 'remove files (dirs with -r, -f silences errors)',
  run(ctx, args, io) {
    const { flags, rest } = splitFlags(args);
    if (!rest.length) return io.err('rm: missing operand');
    const s = ctx.session;
    for (const target of rest) {
      const parts = s.resolvePath(target);
      const p = pathString(parts);
      const cwdStr = pathString(s.cwd);
      if (cwdStr === p || cwdStr.startsWith(p + '/')) {
        io.err('rm: cannot remove \'' + target + '\': it contains your current directory');
        continue;
      }
      try { s.fs.remove(parts, s.user, { recursive: flags.has('r') }); }
      catch (e) {
        if (e instanceof ShellError) { if (!flags.has('f')) io.err('rm: ' + e.message); }
        else throw e;
      }
    }
  },
});

registry.register({
  name: 'rmdir', usage: 'rmdir <dir>...', desc: 'remove empty directories',
  run(ctx, args, io) {
    if (!args.length) return io.err('rmdir: missing operand');
    const s = ctx.session;
    for (const target of args) {
      const parts = s.resolvePath(target);
      try {
        const node = s.fs.node(parts, s.user);
        if (!node.isDir) { io.err('rmdir: ' + pathString(parts) + ': Not a directory'); continue; }
        if (node.size) { io.err('rmdir: ' + pathString(parts) + ': Directory not empty'); continue; }
        s.fs.remove(parts, s.user, { recursive: true });
      } catch (e) { if (e instanceof ShellError) io.err('rmdir: ' + e.message); else throw e; }
    }
  },
});

registry.register({
  name: 'cp', usage: 'cp [-r] <src> <dest>', desc: 'copy a file (or dir with -r)',
  run(ctx, args, io) {
    const { flags, rest } = splitFlags(args);
    if (rest.length !== 2) return io.err('usage: cp [-r] <src> <dest>');
    const s = ctx.session;
    s.fs.copy(s.resolvePath(rest[0]), s.resolvePath(rest[1]), s.user, { recursive: flags.has('r') });
  },
});

registry.register({
  name: 'mv', usage: 'mv <src> <dest>', desc: 'move or rename a file or directory',
  run(ctx, args, io) {
    if (args.length !== 2) return io.err('usage: mv <src> <dest>');
    const s = ctx.session;
    const srcParts = s.resolvePath(args[0]);
    const srcStr = pathString(srcParts);
    const finalParts = s.fs.move(srcParts, s.resolvePath(args[1]), s.user);
    const cwdStr = pathString(s.cwd);
    if (cwdStr === srcStr || cwdStr.startsWith(srcStr + '/')) {
      s.cwd = finalParts.concat(s.cwd.slice(srcParts.length));
    }
  },
});
