/* commands/text.js — cat, head, tail, grep, sort, uniq, wc, echo.
   All accept piped input when no file is given. */

function fileLines(ctx, target, io, cmdName) {
  const s = ctx.session;
  try {
    return s.fs.readFile(s.resolvePath(target), s.user).replace(/\n$/, '').split('\n');
  } catch (e) {
    if (e instanceof ShellError) { io.err(cmdName + ': ' + e.message); return null; }
    throw e;
  }
}

function gatherLines(ctx, targets, io, cmdName) {
  if (!targets.length) {
    if (io.stdin) return io.stdin.slice();
    io.err(cmdName + ': no input — give a file, or pipe something in');
    return null;
  }
  const lines = [];
  let ok = false;
  for (const t of targets) {
    const l = fileLines(ctx, t, io, cmdName);
    if (l) { lines.push(...l); ok = true; }
  }
  return ok ? lines : null;
}

registry.register({
  name: 'cat', usage: 'cat [-n] <file>...', desc: 'print file contents (-n numbers lines)',
  run(ctx, args, io) {
    const { flags, rest } = splitFlags(args);
    let lines;
    if (!rest.length) {
      if (!io.stdin) return io.err('cat: missing file operand');
      lines = io.stdin.slice();
    } else {
      lines = [];
      for (const t of rest) {
        const l = fileLines(ctx, t, io, 'cat');
        if (l) lines.push(...l);
      }
    }
    if (flags.has('n')) lines = lines.map((l, i) => String(i + 1).padStart(6) + '  ' + l);
    if (lines.length) io.out(lines.join('\n'));
  },
});

function headTail(which) {
  return (ctx, args, io) => {
    let n = 10;
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-n') { n = parseInt(args[++i], 10) || 10; }
      else if (/^-\d+$/.test(args[i])) { n = parseInt(args[i].slice(1), 10); }
      else rest.push(args[i]);
    }
    const lines = gatherLines(ctx, rest, io, which);
    if (lines) io.out((which === 'head' ? lines.slice(0, n) : lines.slice(-n)).join('\n'));
  };
}
registry.register({ name: 'head', usage: 'head [-n N] [file]', desc: 'print the first N lines (default 10)', run: headTail('head') });
registry.register({ name: 'tail', usage: 'tail [-n N] [file]', desc: 'print the last N lines (default 10)', run: headTail('tail') });

registry.register({
  name: 'grep', usage: 'grep [-i] [-n] [-v] [-c] <text> [file]...', desc: 'print lines containing text',
  run(ctx, args, io) {
    const { flags, rest } = splitFlags(args);
    if (!rest.length) return io.err('usage: grep <text> <file>   or:   <cmd> | grep <text>');
    const needleRaw = rest.shift();
    const needle = flags.has('i') ? needleRaw.toLowerCase() : needleRaw;
    const emit = (label, lines) => {
      let count = 0;
      lines.forEach((line, idx) => {
        const hay = flags.has('i') ? line.toLowerCase() : line;
        let match = hay.includes(needle);
        if (flags.has('v')) match = !match;
        if (!match) return;
        count++;
        if (!flags.has('c')) io.out((label ? label + ':' : '') + (flags.has('n') ? (idx + 1) + ':' : '') + line);
      });
      if (flags.has('c')) io.out((label ? label + ':' : '') + count);
    };
    if (!rest.length) {
      if (!io.stdin) return io.err('grep: no input — give a file, or pipe something in');
      emit('', io.stdin);
    } else {
      const multi = rest.length > 1;
      for (const t of rest) {
        const lines = fileLines(ctx, t, io, 'grep');
        if (lines) emit(multi ? t : '', lines);
      }
    }
  },
});

registry.register({
  name: 'sort', usage: 'sort [-r] [-n] [file]', desc: 'sort lines (-r reverse, -n numeric)',
  run(ctx, args, io) {
    const { flags, rest } = splitFlags(args);
    const lines = gatherLines(ctx, rest, io, 'sort');
    if (!lines) return;
    const sorted = flags.has('n')
      ? lines.slice().sort((a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0))
      : lines.slice().sort();
    if (flags.has('r')) sorted.reverse();
    if (sorted.length) io.out(sorted.join('\n'));
  },
});

registry.register({
  name: 'uniq', usage: 'uniq [-c] [file]', desc: 'drop repeated adjacent lines (-c counts them)',
  run(ctx, args, io) {
    const { flags, rest } = splitFlags(args);
    const lines = gatherLines(ctx, rest, io, 'uniq');
    if (!lines) return;
    const res = [];
    let prev = null, count = 0;
    const flush = () => { if (count) res.push(flags.has('c') ? String(count).padStart(7) + ' ' + prev : prev); };
    for (const line of lines) {
      if (line === prev) count++;
      else { flush(); prev = line; count = 1; }
    }
    flush();
    if (res.length) io.out(res.join('\n'));
  },
});

registry.register({
  name: 'wc', usage: 'wc [-l] [-w] [-c] [file]...', desc: 'count lines, words, and characters',
  run(ctx, args, io) {
    const { flags, rest } = splitFlags(args);
    const all = !flags.has('l') && !flags.has('w') && !flags.has('c');
    const report = (content, label) => {
      const parts = [];
      if (all || flags.has('l')) parts.push(String((content.match(/\n/g) || []).length).padStart(5));
      if (all || flags.has('w')) parts.push(String((content.trim().match(/\S+/g) || []).length).padStart(6));
      if (all || flags.has('c')) parts.push(String(content.length).padStart(7));
      io.out(parts.join('') + (label ? '  ' + label : ''));
    };
    if (!rest.length) {
      if (!io.stdin) return io.err('wc: no input — give a file, or pipe something in');
      report(io.stdin.length ? io.stdin.join('\n') + '\n' : '', '');
    } else {
      const s = ctx.session;
      for (const t of rest) {
        try { report(s.fs.readFile(s.resolvePath(t), s.user), t); }
        catch (e) { if (e instanceof ShellError) io.err('wc: ' + e.message); else throw e; }
      }
    }
  },
});

registry.register({
  name: 'echo', usage: 'echo [text] [> file | >> file]', desc: 'print text (redirect with > or >>)',
  run(ctx, args, io) { io.out(args.join(' ')); },
});

registry.register({
  name: 'base64', usage: 'base64 [-d] [file]', desc: 'encode or decode base64 (reads a file or piped input)',
  run(ctx, args, io) {
    const { flags, rest } = splitFlags(args.filter(a => a !== '--decode' && a !== '--wrap=0').concat(args.includes('--decode') ? ['-d'] : []));
    const lines = gatherLines(ctx, rest, io, 'base64');
    if (!lines) return;
    const input = lines.join('\n');
    if (flags.has('d')) {
      try { io.out(decodeURIComponent(escape(atob(input.replace(/\s+/g, ''))))); }
      catch (e) { io.err('base64: invalid input'); }
    } else io.out(btoa(unescape(encodeURIComponent(input + (rest.length ? '\n' : '')))));
  },
});
