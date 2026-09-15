/* commands/net.js — host-level networking: ssh between exam hosts, ping,
   host, hostname, ifconfig, and curl/wget against node ports / the API. */

registry.register({
  name: 'ssh', usage: 'ssh [user@]<host>', desc: 'log into another host (exit returns)',
  interactive: true,
  async run(ctx, args, io) {
    const target0 = args.filter(a => !a.startsWith('-'))[0];
    if (!target0) return io.err('usage: ssh [user@]hostname [command]');
    const at = target0.indexOf('@');
    const userName = at === -1 ? ctx.session.user.name : target0.slice(0, at);
    const hostSpec = at === -1 ? target0 : target0.slice(at + 1);
    const target = ctx.world.lookup(hostSpec);
    if (!target) return io.err('ssh: Could not resolve hostname ' + hostSpec + ': Name or service not known');
    if (!target.up) return io.err('ssh: connect to host ' + hostSpec + ' port 22: No route to host');
    const user = target.getUser(userName);
    if (!user || userName === 'root') {
      return io.err(userName + '@' + hostSpec + ': Permission denied (publickey).' + (userName === 'root' ? '\n(ssh as ' + ctx.world.candidate + ' and use sudo -i)' : ''));
    }
    if (user.password !== null) {
      const pw = await ctx.term.readLine({ prompt: esc(userName + '@' + hostSpec) + '\'s password: ', mask: true });
      if (pw === null || !user.authenticate(pw)) return io.err('Permission denied (password).');
    }
    const remoteCmd = args.slice(args.indexOf(target0) + 1);
    if (remoteCmd.length) {
      const sess = new Session(target, user);
      await ctx.shell.runAs(sess, remoteCmd.join(' '));
      return;
    }
    ctx.shell.push(new Session(target, user));
    ctx.term.print('Welcome to Ubuntu 22.04.4 LTS (GNU/Linux 5.15.0-119-generic x86_64)', 'dim');
    ctx.term.print('Last login: ' + new Date(Date.now() - 3600e3).toUTCString().replace('GMT', '') + 'from ' + ctx.session.host.ip, 'dim');
  },
});

registry.register({
  name: 'ping', usage: 'ping [-c N] <host>', desc: 'send simulated echo requests',
  run(ctx, args, io) {
    let n = 4; const rest = [];
    for (let i = 0; i < args.length; i++) { if (args[i] === '-c') n = Math.max(1, Math.min(20, parseInt(args[++i], 10) || 4)); else rest.push(args[i]); }
    const target = rest[0];
    if (!target) return io.err('usage: ping [-c N] <host>');
    const self = ctx.session.host;
    const h = target === 'localhost' || target === '127.0.0.1' ? self : ctx.world.lookup(target);
    if (!h) return io.err('ping: cannot resolve ' + target + ': Unknown host');
    const ip = target === 'localhost' ? '127.0.0.1' : h.ip;
    io.out('PING ' + target + ' (' + ip + ') 56(84) bytes of data.');
    let received = 0;
    for (let i = 1; i <= n; i++) {
      if (!h.up) continue;
      received++;
      const t = ((h === self ? 0.05 : h.latency) + Math.random() * 0.4).toFixed(3);
      io.out('64 bytes from ' + (h === self ? 'localhost' : h.hostname) + ' (' + ip + '): icmp_seq=' + i + ' ttl=64 time=' + t + ' ms');
    }
    io.out('\n--- ' + target + ' ping statistics ---');
    io.out(n + ' packets transmitted, ' + received + ' received, ' + (((n - received) / n) * 100).toFixed(0) + '% packet loss, time ' + (n * 1000) + 'ms');
  },
});

registry.register({ name: 'host', usage: 'host <name>', desc: 'look up a host', run(ctx, args, io) { const h = args[0] && ctx.world.lookup(args[0]); if (!h) return io.err('Host ' + (args[0] || '') + ' not found: 3(NXDOMAIN)'); io.out(h.hostname + ' has address ' + h.ip); } });
registry.register({ name: 'hostname', usage: 'hostname', desc: 'print this host\'s name', run(ctx, args, io) { io.out(ctx.session.host.hostname); } });
registry.register({ name: 'ifconfig', usage: 'ifconfig', desc: 'show network interfaces', run(ctx, args, io) { const h = ctx.session.host; io.out('eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n        inet ' + h.ip + '  netmask 255.255.255.0  broadcast 10.0.0.255\n        ether 02:42:' + shortHash(h.hostname, 8).match(/../g).join(':') + '  txqueuelen 1000  (Ethernet)\n\nlo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536\n        inet 127.0.0.1  netmask 255.0.0.0'); } });

function hostHttp(ctx, args, io, tool) {
  const url = args.filter(a => !a.startsWith('-'))[0];
  if (!url) return io.err(tool + ': no URL specified');
  const m = url.match(/^(?:(https?):\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/);
  if (!m) return io.err(tool + ': bad URL ' + url);
  const scheme = m[1] || 'http', hostSpec = m[2], port = parseInt(m[3] || (scheme === 'https' ? '443' : '80'), 10), path = m[4] || '/';
  const self = ctx.session.host;
  const h = hostSpec === 'localhost' || hostSpec === '127.0.0.1' ? self : ctx.world.lookup(hostSpec);
  if (!h) return io.err(tool === 'curl' ? 'curl: (6) Could not resolve host: ' + hostSpec : 'wget: unable to resolve host address \'' + hostSpec + '\'');
  const cluster = h.node && h.node.cluster;
  if (port === 6443 && cluster) {
    const health = cluster.apiHealthy();
    if (!health.ok) return io.err(tool === 'curl' ? 'curl: (7) Failed to connect to ' + hostSpec + ' port 6443 after 2 ms: Connection refused' : 'wget: unable to connect to ' + hostSpec + ':6443: Connection refused');
    if (scheme !== 'https') return io.out('Client sent an HTTP request to an HTTPS server.');
    if (!args.includes('-k') && !args.includes('--insecure')) return io.err('curl: (60) SSL certificate problem: unable to get local issuer certificate\nMore details here: https://curl.se/docs/sslcerts.html');
    if (path === '/healthz' || path === '/livez' || path === '/readyz') return io.out('ok');
    if (path === '/version') return io.out(JSON.stringify({ major: '1', minor: cluster.version.split('.')[1], gitVersion: 'v' + cluster.version, platform: 'linux/amd64' }, null, 2));
    return io.out('{\n  "kind": "Status",\n  "apiVersion": "v1",\n  "metadata": {},\n  "status": "Failure",\n  "message": "forbidden: User \\"system:anonymous\\" cannot get path \\"' + path + '\\"",\n  "reason": "Forbidden",\n  "details": {},\n  "code": 403\n}');
  }
  if (port === 10250 && cluster) return io.err('curl: (60) SSL certificate problem');
  if (port >= 30000 && port <= 32767 && cluster) {
    const svc = cluster.list(cluster.kinds.resolve('svc'), null).find(s => (s.spec.ports || []).some(p => p.nodePort === port));
    if (!svc) return io.err(tool === 'curl' ? 'curl: (7) Failed to connect to ' + hostSpec + ' port ' + port + ' after 1 ms: Connection refused' : 'wget: unable to connect to ' + hostSpec + ':' + port + ': Connection refused');
    const ep = Printers.endpointsFor(cluster, svc);
    if (!ep.subsets.length) return io.err(tool === 'curl' ? 'curl: (7) Failed to connect to ' + hostSpec + ' port ' + port + ': Connection refused' : 'wget: unable to connect: Connection refused');
    const pod = cluster.list(cluster.kinds.resolve('pod'), svc.metadata.namespace).find(p => p.metadata.uid === ep.subsets[0].addresses[0].targetRef.uid);
    const img = pod.spec.containers[0].image;
    if (/nginx/.test(img)) return io.out('<!DOCTYPE html>\n<html>\n<head>\n<title>Welcome to nginx!</title>\n</head>\n<body>\n<h1>Welcome to nginx!</h1>\n<p>If you see this page, the nginx web server is successfully installed and\nworking. Further configuration is required.</p>\n</body>\n</html>');
    if (/httpd/.test(img)) return io.out('<html><body><h1>It works!</h1></body></html>');
    return io.out('Hello from ' + pod.metadata.name);
  }
  return io.err(tool === 'curl' ? 'curl: (7) Failed to connect to ' + hostSpec + ' port ' + port + ' after 1 ms: Connection refused' : 'wget: unable to connect to ' + hostSpec + ':' + port + ': Connection refused');
}
registry.register({ name: 'curl', usage: 'curl [-k] <url>', desc: 'HTTP client (NodePorts and the API server respond)', run(ctx, args, io) { return hostHttp(ctx, args, io, 'curl'); } });
registry.register({ name: 'wget', usage: 'wget -qO- <url>', desc: 'HTTP client', run(ctx, args, io) { return hostHttp(ctx, args, io, 'wget'); } });
