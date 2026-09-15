/* commands/nodetools.js — what you run after ssh-ing into a node:
   sudo, systemctl, journalctl, etcdctl, kubeadm, apt/apt-get/apt-mark,
   crictl, ip, free, uptime. */

function requireRoot(ctx, msg) {
  if (!ctx.session.user.admin) throw new ShellError(msg);
}
function svcName(n) { return String(n).replace(/\.service$/, ''); }
function tsNow() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function sysdDate(ms) {
  const d = new Date(ms);
  return d.toUTCString().replace(/^(\w{3}), (\d{2}) (\w{3}) (\d{4}) (\d{2}:\d{2}:\d{2}) GMT$/, (m, dow, day, mon, y, t) => dow + ' ' + y + '-' + String(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(mon) + 1).padStart(2, '0') + '-' + day + ' ' + t + ' UTC');
}
function shellQuote(a) { return /^[\w@%+=:,./-]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\''") + "'"; }

registry.register({
  name: 'sudo', usage: 'sudo -i | sudo <command>', desc: 'run a command as root (or -i for a root shell)',
  interactive: true,
  async run(ctx, args, io) {
    const s = ctx.session;
    const root = s.host.getUser('root');
    if (!root) throw new ShellError('root account not found');
    if (!args.length || args[0] === '-i' || args[0] === '-s' || (args[0] === 'su' && (args[1] === '-' || !args[1]))) {
      const sess = new Session(s.host, root);
      ctx.shell.push(sess);
      return;
    }
    const argv = args.filter(a => !['-E', '-H', '--'].includes(a));
    const sess = new Session(s.host, root, { env: s.env });
    sess.cwd = s.cwd.slice();
    await ctx.shell.runAs(sess, argv.map(shellQuote).join(' '));
  },
});

registry.register({
  name: 'systemctl', usage: 'systemctl status|start|stop|restart|enable|disable|daemon-reload|is-active [unit]', desc: 'control system services',
  run(ctx, args, io) {
    const host = ctx.session.host;
    const opts = args.filter(a => a.startsWith('-'));
    const pos = args.filter(a => !a.startsWith('-'));
    const sub = pos[0];
    const unit = pos[1] ? svcName(pos[1]) : null;
    args = pos.concat(opts);
    if (!sub) return io.out(Printers.table(['UNIT', 'LOAD', 'ACTIVE', 'SUB', 'DESCRIPTION'], [...host.services.values()].map(s => [s.name + '.service', 'loaded', s.active ? 'active' : 'inactive', s.active ? 'running' : 'dead', s.description])));
    if (sub === 'daemon-reload') { requireRoot(ctx, 'Failed to reload daemon: Access denied'); return; }
    if (sub === 'list-units' || sub === 'list-unit-files') return io.out(Printers.table(['UNIT', 'LOAD', 'ACTIVE', 'SUB', 'DESCRIPTION'], [...host.services.values()].map(s => [s.name + '.service', 'loaded', s.active ? 'active' : 'inactive', s.active ? 'running' : 'dead', s.description])));
    if (!unit) throw new ShellError('Too few arguments.');
    const svc = host.service(unit);
    if (!svc) {
      if (sub === 'status') { io.err('Unit ' + unit + '.service could not be found.'); return; }
      throw new ShellError('Failed to ' + sub + ' ' + unit + '.service: Unit ' + unit + '.service not found.');
    }
    if (sub === 'status') {
      const problem = svc.failed ? host.serviceHealthProblem(svc) : null;
      const L = [];
      L.push((svc.active ? '● ' : svc.failed ? '× ' : '○ ') + svc.name + '.service - ' + svc.description);
      L.push('     Loaded: loaded (' + (svc.unitFile || '/usr/lib/systemd/system/' + svc.name + '.service') + '; ' + (svc.enabled ? 'enabled' : 'disabled') + '; preset: enabled)');
      if (svc.name === 'kubelet') { L.push('    Drop-In: /etc/systemd/system/kubelet.service.d'); L.push('             └─10-kubeadm.conf'); }
      if (svc.active) L.push('     Active: active (running) since ' + sysdDate(svc.lastChange) + '; ' + ageString(svc.lastChange) + ' ago');
      else if (svc.failed) L.push('     Active: activating (auto-restart) (Result: exit-code) since ' + sysdDate(svc.lastChange) + '; ' + ageString(svc.lastChange) + ' ago');
      else L.push('     Active: inactive (dead) since ' + sysdDate(svc.lastChange) + '; ' + ageString(svc.lastChange) + ' ago');
      if (svc.name === 'kubelet') L.push('       Docs: https://kubernetes.io/docs/');
      if (svc.active) {
        L.push('   Main PID: ' + (1000 + parseInt(shortHash(svc.name, 4), 16) % 9000) + ' (' + svc.name + ')');
        L.push('      Tasks: ' + (svc.name === 'kubelet' ? 14 : 9));
        L.push('     Memory: ' + (svc.name === 'kubelet' ? '48.5M' : '31.2M'));
        L.push('        CPU: 1min 12.402s');
        L.push('     CGroup: /system.slice/' + svc.name + '.service');
        L.push('             └─' + (1000 + parseInt(shortHash(svc.name, 4), 16) % 9000) + ' /usr/bin/' + svc.name + (svc.name === 'kubelet' ? ' --bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf --kubeconfig=/etc/kubernetes/kubelet.conf --config=/var/lib/kubelet/config.yaml --container-runtime-endpoint=unix:///var/run/containerd/containerd.sock --pod-infra-container-image=registry.k8s.io/pause:3.10' : ''));
      }
      L.push('');
      const journal = svc.journal.slice(-6);
      for (const j of journal) L.push(tsNow().slice(5) + ' ' + host.hostname + ' ' + (svc.name === 'kubelet' ? 'kubelet' : svc.name) + '[' + (1000 + parseInt(shortHash(svc.name, 4), 16) % 9000) + ']: ' + j.line);
      if (svc.failed && problem) L.push(tsNow().slice(5) + ' ' + host.hostname + ' systemd[1]: ' + svc.name + '.service: Main process exited, code=exited, status=1/FAILURE');
      if (svc.failed && problem) L.push(tsNow().slice(5) + ' ' + host.hostname + ' systemd[1]: ' + svc.name + '.service: Failed with result \'exit-code\'.');
      if (svc.active && svc.name === 'kubelet' && !journal.length) L.push(tsNow().slice(5) + ' ' + host.hostname + ' kubelet[' + (1000 + parseInt(shortHash(svc.name, 4), 16) % 9000) + ']: I' + tsNow().slice(5, 10).replace('-', '') + ' ' + tsNow().slice(11) + '       1 kubelet.go:1622] "Node became ready" node="' + host.hostname + '"');
      io.out(L.join('\n'));
      if (!svc.active) throw new RawError('');
      return;
    }
    if (sub === 'is-active') { io.out(svc.active ? 'active' : svc.failed ? 'activating' : 'inactive'); if (!svc.active) throw new RawError(''); return; }
    if (sub === 'is-enabled') { io.out(svc.enabled ? 'enabled' : 'disabled'); return; }
    requireRoot(ctx, 'Failed to ' + sub + ' ' + unit + '.service: Interactive authentication required.\nSee system logs and \'systemctl status ' + unit + '.service\' for details.');
    if (sub === 'start' || sub === 'restart') {
      const problem = host.serviceHealthProblem(svc);
      if (problem) {
        svc.active = false; svc.failed = true; svc.lastChange = Date.now();
        svc.log('E' + tsNow().slice(5, 10).replace('-', '') + ' ' + tsNow().slice(11) + '       1 run.go:72] "command failed" err="' + problem + '"');
        throw new ShellError('Job for ' + svc.name + '.service failed because the control process exited with error code.\nSee "systemctl status ' + svc.name + '.service" and "journalctl -xeu ' + svc.name + '.service" for details.');
      }
      svc.active = true; svc.failed = false; svc.lastChange = Date.now();
      if (svc.name === 'kubelet') {
        host.runningKubeletVersion = (host.packages.kubelet || '').split('-')[0] || host.runningKubeletVersion;
        svc.log('I' + tsNow().slice(5, 10).replace('-', '') + ' ' + tsNow().slice(11) + '       1 server.go:490] "Kubelet version" kubeletVersion="v' + host.runningKubeletVersion + '"');
        svc.log('I' + tsNow().slice(5, 10).replace('-', '') + ' ' + tsNow().slice(11) + '       1 kubelet.go:1622] "Node became ready" node="' + host.hostname + '"');
        if (host.node) Sim.reconcile(host.node.cluster);
      }
      return;
    }
    if (sub === 'stop') {
      svc.active = false; svc.failed = false; svc.lastChange = Date.now();
      if (svc.name === 'kubelet' && host.node) Sim.reconcile(host.node.cluster);
      return;
    }
    if (sub === 'enable') { svc.enabled = true; if (opts.includes('--now')) { svc.active = true; svc.lastChange = Date.now(); } io.err('Created symlink /etc/systemd/system/multi-user.target.wants/' + svc.name + '.service → ' + (svc.unitFile || '/usr/lib/systemd/system/' + svc.name + '.service') + '.'); return; }
    if (sub === 'disable') { svc.enabled = false; if (opts.includes('--now')) { svc.active = false; svc.failed = false; svc.lastChange = Date.now(); } io.err('Removed "/etc/systemd/system/multi-user.target.wants/' + svc.name + '.service".'); return; }
    throw new ShellError('Unknown command verb ' + sub + '.');
  },
});

registry.register({
  name: 'journalctl', usage: 'journalctl -u <unit> [-xe] [-n N] [--no-pager]', desc: 'show service logs',
  run(ctx, args, io) {
    const host = ctx.session.host;
    let unit = null, n = 50;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-u' || args[i] === '--unit') unit = svcName(args[++i]);
      else if (args[i].startsWith('--unit=')) unit = svcName(args[i].slice(7));
      else if (args[i] === '-n' || args[i] === '--lines') n = parseInt(args[++i], 10) || 50;
      else if (/^-[a-z]*u$/.test(args[i])) unit = svcName(args[++i]);
      else if (/^-x?e?u$/.test(args[i])) unit = svcName(args[++i]);
    }
    const svcs = unit ? [host.service(unit)].filter(Boolean) : [...host.services.values()];
    if (unit && !svcs.length) return io.out('-- No entries --');
    const L = [];
    for (const svc of svcs) {
      const pid = 1000 + parseInt(shortHash(svc.name, 4), 16) % 9000;
      L.push(tsNow().slice(5) + ' ' + host.hostname + ' systemd[1]: ' + (svc.active ? 'Started ' : svc.failed ? 'Starting ' : 'Stopped ') + svc.name + '.service - ' + svc.description + '.');
      for (const j of svc.journal) L.push(new Date(j.t).toISOString().replace('T', ' ').slice(5, 19) + ' ' + host.hostname + ' ' + svc.name + '[' + pid + ']: ' + j.line);
      if (svc.failed) {
        const problem = host.serviceHealthProblem(svc);
        L.push(tsNow().slice(5) + ' ' + host.hostname + ' ' + svc.name + '[' + pid + ']: E' + tsNow().slice(5, 10).replace('-', '') + ' ' + tsNow().slice(11) + '       1 run.go:72] "command failed" err="' + (problem || 'unknown') + '"');
        L.push(tsNow().slice(5) + ' ' + host.hostname + ' systemd[1]: ' + svc.name + '.service: Main process exited, code=exited, status=1/FAILURE');
        L.push(tsNow().slice(5) + ' ' + host.hostname + ' systemd[1]: ' + svc.name + '.service: Failed with result \'exit-code\'.');
        L.push(tsNow().slice(5) + ' ' + host.hostname + ' systemd[1]: ' + svc.name + '.service: Scheduled restart job, restart counter is at 7.');
      }
      if (svc.active && svc.name === 'kubelet' && !svc.journal.length) {
        L.push(tsNow().slice(5) + ' ' + host.hostname + ' kubelet[' + pid + ']: I' + tsNow().slice(5, 10).replace('-', '') + ' ' + tsNow().slice(11) + '       1 server.go:490] "Kubelet version" kubeletVersion="v' + host.runningKubeletVersion + '"');
        L.push(tsNow().slice(5) + ' ' + host.hostname + ' kubelet[' + pid + ']: I' + tsNow().slice(5, 10).replace('-', '') + ' ' + tsNow().slice(11) + '       1 kubelet.go:1622] "Node became ready" node="' + host.hostname + '"');
      }
    }
    io.out((L.length ? L.slice(-n) : ['-- No entries --']).join('\n'));
  },
});

registry.register({
  name: 'etcdctl', usage: 'etcdctl snapshot save|restore|status <file> [--endpoints --cacert --cert --key --data-dir]', desc: 'etcd client (snapshot save/restore)',
  run(ctx, args, io) {
    const s = ctx.session;
    const flags = {}; const pos = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('--')) { const eq = a.indexOf('='); if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1); else if (['write-out', 'endpoints', 'cacert', 'cert', 'key', 'data-dir', 'name', 'initial-cluster', 'initial-advertise-peer-urls', 'initial-cluster-token'].includes(a.slice(2))) flags[a.slice(2)] = args[++i]; else flags[a.slice(2)] = true; }
      else if (a === '-w') flags['write-out'] = args[++i];
      else pos.push(a);
    }
    const api = (s.env.ETCDCTL_API || '3');
    if (api !== '3') throw new ShellError('No help topic for \'' + (pos[0] || '') + '\'\n(etcdctl v2 API selected — set ETCDCTL_API=3)');
    const cmd = pos[0], sub = pos[1];
    const needCerts = () => {
      for (const f of ['cacert', 'cert', 'key']) if (!flags[f]) throw new ShellError('{"level":"warn","ts":"' + new Date().toISOString() + '","logger":"etcd-client","caller":"v3@v3.5.15/retry_interceptor.go:63","msg":"retrying of unary invoker failed","target":"etcd-endpoints://0x' + shortHash('ep', 12) + '/' + (flags.endpoints || '127.0.0.1:2379') + '","attempt":0,"error":"rpc error: code = DeadlineExceeded desc = latest balancer error: last connection error: connection error: desc = \\"transport: authentication handshake failed: tls: failed to verify certificate: x509: certificate signed by unknown authority\\""}\nError: context deadline exceeded');
      for (const f of ['cacert', 'cert', 'key']) {
        try { s.fs.readFile(s.resolvePath(flags[f]), s.user); }
        catch (e) { throw new ShellError('Error: open ' + flags[f] + ': ' + (e.message.includes('Permission') ? 'permission denied' : 'no such file or directory')); }
      }
    };
    if (cmd === 'version' || cmd === '--version') return io.out('etcdctl version: 3.5.15\nAPI version: 3.5');
    if (cmd === 'snapshot' && sub === 'save') {
      const file = pos[2];
      if (!file) throw new ShellError('Error: snapshot save expects one argument');
      needCerts();
      const ts = new Date().toISOString();
      io.out('{"level":"info","ts":"' + ts + '","caller":"snapshot/v3_snapshot.go:65","msg":"created temporary db file","path":"' + file + '.part"}');
      io.out('{"level":"info","ts":"' + ts + '","logger":"client","caller":"v3@v3.5.15/maintenance.go:212","msg":"opened snapshot stream; downloading"}');
      io.out('{"level":"info","ts":"' + ts + '","caller":"snapshot/v3_snapshot.go:73","msg":"fetching snapshot","endpoint":"' + (flags.endpoints || '127.0.0.1:2379') + '"}');
      const cluster = s.host.node && s.host.node.cluster;
      const content = 'etcd-snapshot v3 cluster=' + (cluster ? cluster.name : 'unknown') + ' revision=' + (cluster ? cluster.rv : 0) + ' keys=' + (cluster ? cluster.store.size : 0) + ' ' + shortHash(String(Date.now()), 64) + '\n';
      try { s.fs.writeFile(s.resolvePath(file), content, s.user); }
      catch (e) { throw new ShellError('Error: could not open ' + file + ' (' + e.message + ')'); }
      io.out('{"level":"info","ts":"' + ts + '","logger":"client","caller":"v3@v3.5.15/maintenance.go:220","msg":"completed snapshot read; closing"}');
      io.out('{"level":"info","ts":"' + ts + '","caller":"snapshot/v3_snapshot.go:88","msg":"fetched snapshot","endpoint":"' + (flags.endpoints || '127.0.0.1:2379') + '","size":"4.1 MB","took":"now"}');
      io.out('{"level":"info","ts":"' + ts + '","caller":"snapshot/v3_snapshot.go:97","msg":"saved","path":"' + file + '"}');
      io.out('Snapshot saved at ' + file);
      return;
    }
    if (cmd === 'snapshot' && sub === 'status') {
      const file = pos[2];
      let text;
      try { text = s.fs.readFile(s.resolvePath(file), s.user); } catch (e) { throw new ShellError('Error: stat ' + file + ': no such file or directory'); }
      const rev = (text.match(/revision=(\d+)/) || [, '1000'])[1], keys = (text.match(/keys=(\d+)/) || [, '100'])[1];
      const hash = parseInt(shortHash(text, 8), 16);
      if (flags['write-out'] === 'table') return io.out('+----------+----------+------------+------------+\n|   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE |\n+----------+----------+------------+------------+\n| ' + hash.toString(16).padEnd(8) + ' | ' + String(rev).padStart(8) + ' | ' + String(keys).padStart(10) + ' |     4.1 MB |\n+----------+----------+------------+------------+');
      return io.out(hash.toString(16) + ', ' + rev + ', ' + keys + ', 4.1 MB');
    }
    if (cmd === 'snapshot' && sub === 'restore') {
      const file = pos[2];
      if (!file) throw new ShellError('Error: snapshot restore requires exactly one argument');
      try { s.fs.readFile(s.resolvePath(file), s.user); } catch (e) { throw new ShellError('Error: open ' + file + ': no such file or directory'); }
      const dataDir = flags['data-dir'] || 'default.etcd';
      const parts = s.resolvePath(dataDir);
      if (s.fs.exists(parts, null)) throw new ShellError('Error: data-dir "' + dataDir + '" exists');
      s.fs.mkdir(parts.concat(['member', 'snap']), s.user, { parents: true, mode: 0o700 });
      s.fs.mkdir(parts.concat(['member', 'wal']), s.user, { parents: true, mode: 0o700 });
      s.fs.writeFile(parts.concat(['member', 'snap', 'db']), 'etcd-db restored from ' + file + '\n', s.user);
      const ts = new Date().toISOString();
      io.out('{"level":"info","ts":"' + ts + '","caller":"snapshot/v3_snapshot.go:265","msg":"restoring snapshot","path":"' + file + '","wal-dir":"' + dataDir + '/member/wal","data-dir":"' + dataDir + '","snap-dir":"' + dataDir + '/member/snap"}');
      io.out('{"level":"info","ts":"' + ts + '","caller":"membership/store.go:141","msg":"Trimming membership information from the backend..."}');
      io.out('{"level":"info","ts":"' + ts + '","caller":"membership/cluster.go:421","msg":"added member","cluster-id":"cdf818194e3a8c32","local-member-id":"0","added-peer-id":"8e9e05c52164694d","added-peer-peer-urls":["http://localhost:2380"]}');
      io.out('{"level":"info","ts":"' + ts + '","caller":"snapshot/v3_snapshot.go:293","msg":"restored snapshot","path":"' + file + '","wal-dir":"' + dataDir + '/member/wal","data-dir":"' + dataDir + '","snap-dir":"' + dataDir + '/member/snap"}');
      s.host.restoredEtcdDir = pathString(parts);
      return;
    }
    if (cmd === 'member' && sub === 'list') { needCerts(); return io.out(shortHash('member', 16) + ', started, control, https://' + s.host.ip + ':2380, https://' + s.host.ip + ':2379, false'); }
    if (cmd === 'endpoint' && (sub === 'health' || sub === 'status')) { needCerts(); return io.out(sub === 'health' ? (flags.endpoints || '127.0.0.1:2379') + ' is healthy: successfully committed proposal: took = 4.31ms' : (flags.endpoints || '127.0.0.1:2379') + ', ' + shortHash('member', 16) + ', 3.5.15, 4.1 MB, true, false, 12, ' + (s.host.node ? s.host.node.cluster.rv : 1000) + ', ' + (s.host.node ? s.host.node.cluster.rv : 1000) + ', '); }
    if (cmd === 'get') { needCerts(); const cluster = s.host.node && s.host.node.cluster; const keys = cluster ? cluster.all().slice(0, 20).map(o => '/registry/' + (cluster.kinds.byKind(o.kind) || { plural: o.kind.toLowerCase() }).plural + '/' + (o.metadata.namespace ? o.metadata.namespace + '/' : '') + o.metadata.name) : []; return io.out(keys.join('\n')); }
    throw new ShellError('Error: unknown command "' + (cmd || '') + (sub ? ' ' + sub : '') + '" for "etcdctl" (snapshot save|restore|status, member list, endpoint health)');
  },
});

registry.register({
  name: 'kubeadm', usage: 'kubeadm upgrade plan|apply <version>|node, kubeadm version, kubeadm token create --print-join-command', desc: 'cluster bootstrapping and upgrades',
  run(ctx, args, io) {
    const host = ctx.session.host;
    const sub = args[0], sub2 = args[1];
    const pkgVer = () => (host.packages.kubeadm || '0.0.0').split('-')[0];
    if (sub === 'version') return io.out('kubeadm version: &version.Info{Major:"' + pkgVer().split('.')[0] + '", Minor:"' + pkgVer().split('.')[1] + '", GitVersion:"v' + pkgVer() + '", GitCommit:"' + shortHash(pkgVer(), 40) + '", GitTreeState:"clean", BuildDate:"2026-01-15T10:00:00Z", GoVersion:"go1.22.5", Compiler:"gc", Platform:"linux/amd64"}');
    if (!host.node) throw new ShellError('this node is not part of a cluster (kubeadm is only useful on cluster nodes)');
    const cluster = host.node.cluster;
    if (sub === 'upgrade' && sub2 === 'plan') {
      requireRoot(ctx, '[preflight] Some fatal errors occurred:\n\t[ERROR IsPrivilegedUser]: user is not running as root\n[preflight] If you know what you are doing, you can make a check non-fatal with `--ignore-preflight-errors=...`\nerror: [preflight] Some fatal errors occurred');
      if (host.role !== 'control-plane') throw new ShellError('[upgrade/config] FATAL: the node is not a control plane node (no /etc/kubernetes/admin.conf)');
      const latest = (cluster.upgradeVersions || []).slice().sort().pop() || cluster.version;
      const cur = cluster.version;
      const L = [];
      L.push('[preflight] Running pre-flight checks.');
      L.push('[upgrade/config] Reading configuration from the cluster...');
      L.push("[upgrade/config] FYI: You can look at this config file with 'kubectl -n kube-system get cm kubeadm-config -o yaml'");
      L.push('[upgrade] Running cluster health checks');
      L.push('[upgrade] Fetching available versions to upgrade to');
      L.push('[upgrade/versions] Cluster version: v' + cur);
      L.push('[upgrade/versions] kubeadm version: v' + pkgVer());
      L.push('[upgrade/versions] Target version: v' + latest);
      L.push('[upgrade/versions] Latest version in the v' + cur.split('.').slice(0, 2).join('.') + ' series: v' + latest);
      L.push('');
      L.push('Components that must be upgraded manually after you have upgraded the control plane with \'kubeadm upgrade apply\':');
      L.push('COMPONENT   NODE      CURRENT   TARGET');
      for (const n of cluster.nodes()) L.push('kubelet     ' + n.metadata.name.padEnd(9) + ' ' + n.status.nodeInfo.kubeletVersion.padEnd(9) + ' v' + latest);
      L.push('');
      L.push('Upgrade to the latest version in the v' + cur.split('.').slice(0, 2).join('.') + ' series:');
      L.push('');
      L.push('COMPONENT                 NODE      CURRENT    TARGET');
      for (const n of cluster.controlPlaneNodes()) { L.push('kube-apiserver            ' + n.metadata.name.padEnd(9) + ' v' + cur.padEnd(8) + ' v' + latest); L.push('kube-controller-manager   ' + n.metadata.name.padEnd(9) + ' v' + cur.padEnd(8) + ' v' + latest); L.push('kube-scheduler            ' + n.metadata.name.padEnd(9) + ' v' + cur.padEnd(8) + ' v' + latest); L.push('kube-proxy                          ' + ' v' + cur.padEnd(8) + ' v' + latest); L.push('CoreDNS                             ' + ' v1.11.3    v1.11.3'); L.push('etcd                      ' + n.metadata.name.padEnd(9) + ' 3.5.15-0   3.5.15-0'); }
      L.push('');
      L.push('You can now apply the upgrade by executing the following command:');
      L.push('');
      L.push('\tkubeadm upgrade apply v' + latest);
      L.push('');
      if (pkgVer() !== latest) L.push('Note: Before you can perform this upgrade, you have to update kubeadm to v' + latest + '.\n');
      L.push('_____________________________________________________________________\n\nThe table below shows the current state of component configs as understood by this version of kubeadm.\nConfigs that have a "yes" mark in the "MANUAL UPGRADE REQUIRED" column require manual config upgrade.\n\nAPI GROUP                 CURRENT VERSION   PREFERRED VERSION   MANUAL UPGRADE REQUIRED\nkubeproxy.config.k8s.io   v1alpha1          v1alpha1            no\nkubelet.config.k8s.io     v1beta1           v1beta1             no\n_____________________________________________________________________');
      return io.out(L.join('\n'));
    }
    if (sub === 'upgrade' && sub2 === 'apply') {
      requireRoot(ctx, '[preflight] Some fatal errors occurred:\n\t[ERROR IsPrivilegedUser]: user is not running as root\nerror: [preflight] Some fatal errors occurred');
      if (host.role !== 'control-plane') throw new ShellError('[upgrade/config] FATAL: the node is not a control plane node');
      const target = (args.find(a => /^v?\d+\.\d+\.\d+$/.test(a)) || '').replace(/^v/, '');
      if (!target) throw new ShellError('[upgrade/version] FATAL: missing one or more required arguments: the version to upgrade to (e.g. kubeadm upgrade apply v1.31.2)');
      if (!(cluster.upgradeVersions || []).includes(target) && target !== cluster.version) throw new ShellError('[upgrade/version] FATAL: unable to fetch version "v' + target + '": version not available in this environment');
      const kv = pkgVer();
      const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
      if (cmp(target, kv) > 0) throw new ShellError('[upgrade/version] FATAL: the specified version to upgrade to "v' + target + '" is higher than the kubeadm version "v' + kv + '". Upgrade kubeadm first using the tool you used to install kubeadm');
      if (cmp(target, cluster.version) < 0) throw new ShellError('[upgrade/version] FATAL: the specified version to upgrade to "v' + target + '" is lower than the cluster version "v' + cluster.version + '"');
      const L = [];
      L.push('[preflight] Running pre-flight checks.');
      L.push('[upgrade/config] Reading configuration from the cluster...');
      L.push('[upgrade] Running cluster health checks');
      L.push('[upgrade/version] You have chosen to change the cluster version to "v' + target + '"');
      L.push('[upgrade/versions] Cluster version: v' + cluster.version);
      L.push('[upgrade/versions] kubeadm version: v' + kv);
      if (!args.includes('-y') && !args.includes('--yes')) L.push('[upgrade] Are you sure you want to proceed? [y/N]: y  (auto-confirmed in this simulator; use -y to skip the prompt)');
      L.push('[upgrade/prepull] Pulling images required for setting up a Kubernetes cluster');
      L.push('[upgrade/prepull] This might take a minute or two, depending on the speed of your internet connection');
      L.push('[upgrade/apply] Upgrading your Static Pod-hosted control plane to version "v' + target + '" (timeout: 5m0s)...');
      L.push('[upgrade/etcd] Upgrading to TLS for etcd');
      L.push('[upgrade/staticpods] Preparing for "etcd" upgrade');
      L.push('[upgrade/staticpods] Current and new manifests of etcd are equal, skipping upgrade');
      for (const c of ['kube-apiserver', 'kube-controller-manager', 'kube-scheduler']) {
        L.push('[upgrade/staticpods] Preparing for "' + c + '" upgrade');
        L.push('[upgrade/staticpods] Renewing ' + c + ' certificate');
        L.push('[upgrade/staticpods] Moved new manifest to "/etc/kubernetes/manifests/' + c + '.yaml" and backed up old manifest to "/etc/kubernetes/tmp/kubeadm-backup-manifests-' + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '-') + '/' + c + '.yaml"');
        L.push('[upgrade/staticpods] Waiting for the kubelet to restart the component');
        L.push('[apiclient] Found 1 Pods for label selector component=' + c);
        L.push('[upgrade/staticpods] Component "' + c + '" upgraded successfully!');
      }
      L.push('[upload-config] Storing the configuration used in ConfigMap "kubeadm-config" in the "kube-system" Namespace');
      L.push('[kubelet] Creating a ConfigMap "kubelet-config" in namespace kube-system with the configuration for the kubelets in the cluster');
      L.push('[upgrade] Backing up kubelet config file to /etc/kubernetes/tmp/kubeadm-kubelet-config' + shortHash(target, 9) + '/config.yaml');
      L.push('[kubelet-start] Writing kubelet configuration to file "/var/lib/kubelet/config.yaml"');
      L.push('[bootstrap-token] Configured RBAC rules to allow Node Bootstrap tokens to get nodes');
      L.push('[addons] Applied essential addon: CoreDNS');
      L.push('[addons] Applied essential addon: kube-proxy');
      L.push('');
      L.push('[upgrade/successful] SUCCESS! Your cluster was upgraded to "v' + target + '". Enjoy!');
      L.push('');
      L.push('[upgrade/kubelet] Now that your control plane is upgraded, please proceed with upgrading your kubelets if you haven\'t already done so.');
      ctx.app.world.upgradeControlPlane(cluster, host, target);
      host.upgradedNodeConfig = target;
      host.seedDir('/etc/kubernetes/tmp');
      return io.out(L.join('\n'));
    }
    if (sub === 'upgrade' && sub2 === 'node') {
      requireRoot(ctx, '[preflight] Some fatal errors occurred:\n\t[ERROR IsPrivilegedUser]: user is not running as root\nerror: [preflight] Some fatal errors occurred');
      const L = ['[upgrade] Reading configuration from the cluster...', "[upgrade] FYI: You can look at this config file with 'kubectl -n kube-system get cm kubeadm-config -o yaml'"];
      if (host.role === 'control-plane') L.push('[upgrade] Upgrading your Static Pod-hosted control plane instance to version "v' + cluster.version + '"...', '[upgrade/staticpods] Current and new manifests of kube-apiserver are equal, skipping upgrade');
      else L.push('[preflight] Running pre-flight checks', '[preflight] Skipping prepull. Not a control plane node.', '[upgrade] Skipping phase. Not a control plane node.');
      L.push('[upgrade] Backing up kubelet config file to /etc/kubernetes/tmp/kubeadm-kubelet-config' + shortHash(cluster.version, 9) + '/config.yaml');
      L.push('[kubelet-start] Writing kubelet configuration to file "/var/lib/kubelet/config.yaml"');
      L.push('[upgrade] The configuration for this node was successfully updated!');
      L.push('[upgrade] Now you should go ahead and upgrade the kubelet package using your package manager.');
      host.upgradedNodeConfig = cluster.version;
      return io.out(L.join('\n'));
    }
    if (sub === 'token' && sub2 === 'create') {
      requireRoot(ctx, 'error: unable to create token: user is not running as root');
      const token = shortHash('a' + Date.now(), 6) + '.' + shortHash('b' + Date.now(), 16);
      const cp = cluster.controlPlaneNodes()[0]; const cpHost = cp && cluster.nodeHost(cp.metadata.name);
      if (args.includes('--print-join-command')) return io.out('kubeadm join ' + (cpHost ? cpHost.ip : '127.0.0.1') + ':6443 --token ' + token + ' --discovery-token-ca-cert-hash sha256:' + shortHash('ca' + cluster.name, 64));
      return io.out(token);
    }
    if (sub === 'token' && sub2 === 'list') return io.out('TOKEN                     TTL         EXPIRES                USAGES                   DESCRIPTION                                                EXTRA GROUPS\n' + shortHash('a', 6) + '.' + shortHash('b', 16) + '   23h         ' + new Date(Date.now() + 82800e3).toISOString().slice(0, 19) + 'Z   authentication,signing   <none>                                                     system:bootstrappers:kubeadm:default-node-token');
    if (sub === 'certs' && sub2 === 'check-expiration') {
      requireRoot(ctx, 'error: user is not running as root');
      const exp = new Date(Date.now() + 300 * 86400e3).toUTCString().slice(5, 25);
      return io.out('[check-expiration] Reading configuration from the cluster...\n\nCERTIFICATE                EXPIRES                  RESIDUAL TIME   CERTIFICATE AUTHORITY   EXTERNALLY MANAGED\nadmin.conf                 ' + exp + '   300d            ca                      no\napiserver                  ' + exp + '   300d            ca                      no\napiserver-etcd-client      ' + exp + '   300d            etcd-ca                 no\napiserver-kubelet-client   ' + exp + '   300d            ca                      no\ncontroller-manager.conf    ' + exp + '   300d            ca                      no\netcd-healthcheck-client    ' + exp + '   300d            etcd-ca                 no\netcd-peer                  ' + exp + '   300d            etcd-ca                 no\netcd-server                ' + exp + '   300d            etcd-ca                 no\nfront-proxy-client         ' + exp + '   300d            front-proxy-ca          no\nscheduler.conf             ' + exp + '   300d            ca                      no\n\nCERTIFICATE AUTHORITY   EXPIRES                  RESIDUAL TIME   EXTERNALLY MANAGED\nca                      ' + exp + '   9y              no\netcd-ca                 ' + exp + '   9y              no\nfront-proxy-ca          ' + exp + '   9y              no');
    }
    if (sub === 'init' || sub === 'join' || sub === 'reset') throw new ShellError('kubeadm ' + sub + ' is not simulated in this environment (clusters are pre-built). Supported: upgrade plan|apply|node, token create, certs check-expiration, version');
    throw new ShellError('unknown command "' + (sub || '') + (sub2 ? ' ' + sub2 : '') + '" for "kubeadm"');
  },
});

function aptInstall(ctx, args, io, cmdName) {
  const host = ctx.session.host;
  const sub = args.find(a => !a.startsWith('-'));
  const yes = args.includes('-y') || args.includes('--yes') || args.includes('--assume-yes');
  const allowHeld = args.includes('--allow-change-held-packages');
  if (sub === 'update') {
    requireRoot(ctx, 'Reading package lists... Done\nE: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)\nE: Unable to lock directory /var/lib/apt/lists/');
    return io.out('Hit:1 http://archive.ubuntu.com/ubuntu jammy InRelease\nHit:2 http://archive.ubuntu.com/ubuntu jammy-updates InRelease\nHit:3 https://pkgs.k8s.io/core:/stable:/v' + (host.packages.kubeadm || '1.31').split('.').slice(0, 2).join('.') + '/deb  InRelease\nReading package lists... Done');
  }
  if (sub === 'install') {
    requireRoot(ctx, 'E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?');
    const pkgs = args.slice(args.indexOf('install') + 1).filter(a => !a.startsWith('-'));
    if (!pkgs.length) throw new ShellError('E: Unable to locate package');
    const L = ['Reading package lists... Done', 'Building dependency tree... Done', 'Reading state information... Done'];
    const held = pkgs.map(p => p.split('=')[0]).filter(p => host.heldPackages.has(p));
    if (held.length && !allowHeld) {
      L.push('The following held packages will be changed:\n  ' + held.join(' '));
      L.push('E: Held packages were changed and -y was used without --allow-change-held-packages.');
      io.out(L.join('\n'));
      throw new RawError('');
    }
    for (const spec of pkgs) {
      const [name, ver] = spec.split('=');
      const avail = host.availablePackages[name];
      if (!avail && !(name in host.packages)) throw new ShellError('E: Unable to locate package ' + name);
      if (ver && avail && !avail.includes(ver)) throw new ShellError("E: Version '" + ver + "' for '" + name + "' was not found");
      const target = ver || (avail ? avail[avail.length - 1] : host.packages[name]);
      if (host.packages[name] === target) { L.push(name + ' is already the newest version (' + target + ').'); continue; }
      L.push('The following packages will be upgraded:\n  ' + name + '\n1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.');
      L.push('Get:1 https://pkgs.k8s.io/core:/stable:/v' + target.split('.').slice(0, 2).join('.') + '/deb  ' + name + ' ' + target + ' [' + (name === 'kubelet' ? '15.2 MB' : name === 'kubeadm' ? '11.4 MB' : '10.9 MB') + ']');
      L.push('(Reading database ... 74212 files and directories currently installed.)');
      L.push('Preparing to unpack .../' + name + '_' + target + '_amd64.deb ...');
      L.push('Unpacking ' + name + ' (' + target + ') over (' + (host.packages[name] || 'none') + ') ...');
      L.push('Setting up ' + name + ' (' + target + ') ...');
      host.packages[name] = target;
    }
    io.out(L.join('\n'));
    if (!yes) io.out('(assumed -y)');
    return;
  }
  if (sub === 'remove' || sub === 'purge' || sub === 'autoremove' || sub === 'upgrade' || sub === 'dist-upgrade' || sub === 'full-upgrade') {
    requireRoot(ctx, 'E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)');
    return io.out('Reading package lists... Done\nBuilding dependency tree... Done\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.');
  }
  if (sub === 'list' || sub === 'search') {
    const rows = Object.entries(host.packages).map(([n, v]) => n + '/now ' + v + ' amd64 [installed' + (host.heldPackages.has(n) ? ',held' : '') + ']');
    return io.out('Listing... Done\n' + rows.join('\n'));
  }
  throw new ShellError('E: Invalid operation ' + (sub || ''));
}
registry.register({ name: 'apt-get', usage: 'apt-get update | install [-y] <pkg>=<version>', desc: 'package manager', run(ctx, args, io) { return aptInstall(ctx, args, io, 'apt-get'); } });
registry.register({ name: 'apt', usage: 'apt update | install [-y] <pkg>=<version> | list', desc: 'package manager', run(ctx, args, io) { return aptInstall(ctx, args, io, 'apt'); } });
registry.register({
  name: 'apt-mark', usage: 'apt-mark hold|unhold|showhold <pkg>...', desc: 'hold or release package versions',
  run(ctx, args, io) {
    const host = ctx.session.host;
    const sub = args[0];
    if (sub === 'showhold') return io.out([...host.heldPackages].sort().join('\n'));
    requireRoot(ctx, 'E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)');
    for (const p of args.slice(1)) {
      if (!(p in host.packages)) throw new ShellError('E: Unable to locate package ' + p);
      if (sub === 'hold') { host.heldPackages.add(p); io.out(p + ' set on hold.'); }
      else if (sub === 'unhold') { if (host.heldPackages.delete(p)) io.out('Canceled hold on ' + p + '.'); else io.out(p + ' was already not on hold.'); }
      else throw new ShellError('E: Invalid operation ' + sub);
    }
  },
});
registry.register({
  name: 'apt-cache', usage: 'apt-cache madison <pkg> | policy <pkg>', desc: 'query available package versions',
  run(ctx, args, io) {
    const host = ctx.session.host;
    const name = args[1];
    if (!name) throw new ShellError('E: No packages found');
    const avail = host.availablePackages[name];
    if (!avail) throw new ShellError('N: Unable to locate package ' + name);
    if (args[0] === 'madison') return io.out(avail.slice().reverse().map(v => '   ' + name + ' | ' + v + ' | https://pkgs.k8s.io/core:/stable:/v' + v.split('.').slice(0, 2).join('.') + '/deb  Packages').join('\n'));
    return io.out(name + ':\n  Installed: ' + host.packages[name] + '\n  Candidate: ' + avail[avail.length - 1] + '\n  Version table:\n' + avail.slice().reverse().map(v => (v === host.packages[name] ? ' *** ' : '     ') + v + ' 500\n        500 https://pkgs.k8s.io/core:/stable:/v' + v.split('.').slice(0, 2).join('.') + '/deb  Packages').join('\n'));
  },
});

registry.register({
  name: 'crictl', usage: 'crictl ps | pods | images', desc: 'inspect containers on this node',
  run(ctx, args, io) {
    const host = ctx.session.host;
    requireRoot(ctx, 'FATA[0000] validate service connection: validate CRI v1 runtime API for endpoint "unix:///var/run/containerd/containerd.sock": rpc error: code = Unavailable desc = connection error: desc = "transport: Error while dialing: dial unix /var/run/containerd/containerd.sock: connect: permission denied"');
    if (!host.node) return io.out('CONTAINER   IMAGE   CREATED   STATE   NAME   ATTEMPT   POD ID   POD');
    const cluster = host.node.cluster;
    const pods = cluster.list(cluster.kinds.resolve('pod'), null).filter(p => p.spec.nodeName === host.hostname);
    if (args[0] === 'pods') return io.out(Printers.table(['POD ID', 'CREATED', 'STATE', 'NAME', 'NAMESPACE', 'ATTEMPT', 'RUNTIME'], pods.map(p => [shortHash(p.metadata.uid, 13), Printers.age(p) + ' ago', Printers.podInfo(cluster, p).phase === 'Succeeded' ? 'NotReady' : 'Ready', p.metadata.name, p.metadata.namespace, '0', '(default)'])));
    if (args[0] === 'images') return io.out(Printers.table(['IMAGE', 'TAG', 'IMAGE ID', 'SIZE'], [...new Set(pods.flatMap(p => p.spec.containers.map(c => c.image)))].map(i => [i.split(':')[0], i.split(':')[1] || 'latest', shortHash(i, 13), '45.2MB'])));
    const rows = [];
    for (const p of pods) for (const c of p.spec.containers) { const cs = ((p.status || {}).containerStatuses || []).find(x => x.name === c.name) || {}; rows.push([shortHash(p.metadata.uid + c.name, 13), shortHash(c.image, 13), Printers.age(p) + ' ago', cs.state && cs.state.running ? 'Running' : cs.state && cs.state.terminated ? 'Exited' : 'Created', c.name, String(cs.restartCount || 0), shortHash(p.metadata.uid, 13), p.metadata.name]); }
    io.out(Printers.table(['CONTAINER', 'IMAGE', 'CREATED', 'STATE', 'NAME', 'ATTEMPT', 'POD ID', 'POD'], rows));
  },
});

registry.register({
  name: 'ip', usage: 'ip a | ip route', desc: 'show network interfaces and routes',
  run(ctx, args, io) {
    const h = ctx.session.host;
    if (args[0] === 'route' || args[0] === 'r') return io.out('default via 10.0.0.1 dev eth0 proto dhcp src ' + h.ip + ' metric 100\n10.0.0.0/24 dev eth0 proto kernel scope link src ' + h.ip + (h.node ? '\n10.244.0.0/16 dev flannel.1 proto kernel scope link' : ''));
    io.out('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000\n    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n    inet 127.0.0.1/8 scope host lo\n       valid_lft forever preferred_lft forever\n2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP group default qlen 1000\n    link/ether 02:42:' + shortHash(h.hostname, 8).match(/../g).join(':') + ' brd ff:ff:ff:ff:ff:ff\n    inet ' + h.ip + '/24 brd 10.0.0.255 scope global eth0\n       valid_lft forever preferred_lft forever' + (h.node ? '\n3: flannel.1: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1450 qdisc noqueue state UNKNOWN group default\n    link/ether 5a:' + shortHash(h.hostname + 'f', 10).match(/../g).join(':') + ' brd ff:ff:ff:ff:ff:ff\n    inet 10.244.' + Math.max(0, h.node.cluster.nodeOrder.indexOf(h.hostname)) + '.0/32 scope global flannel.1\n       valid_lft forever preferred_lft forever' : ''));
  },
});
registry.register({ name: 'free', usage: 'free [-h]', desc: 'show memory usage', run(ctx, args, io) { io.out('               total        used        free      shared  buff/cache   available\nMem:           3.8Gi       1.2Gi       1.4Gi        12Mi       1.2Gi       2.4Gi\nSwap:             0B          0B          0B'); } });
registry.register({ name: 'uptime', usage: 'uptime', desc: 'show uptime and load', run(ctx, args, io) { io.out(' ' + new Date().toTimeString().slice(0, 8) + ' up 30 days,  4:12,  1 user,  load average: 0.31, 0.24, 0.19'); } });
registry.register({ name: 'nproc', usage: 'nproc', desc: 'number of processors', run(ctx, args, io) { io.out('2'); } });
registry.register({ name: 'swapoff', usage: 'swapoff -a', desc: 'disable swap', run(ctx) { requireRoot(ctx, 'swapoff: Not superuser.'); } });
registry.register({ name: 'modprobe', usage: 'modprobe <module>', desc: 'load a kernel module', run(ctx) { requireRoot(ctx, 'modprobe: ERROR: could not insert: Operation not permitted'); } });
