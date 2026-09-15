/* core/host.js — a Host: ip, Users, FileSystem, plus what the exam needs
   from a Linux box: systemd-style services, installed/available packages
   (for kubeadm upgrades), and an optional kubeconfig for kubectl. */

class Service {
  constructor(name, { active = true, enabled = true, description = '', unitFile = '', health = null } = {}) {
    this.name = name;
    this.active = active;
    this.enabled = enabled;
    this.description = description || name + '.service';
    this.unitFile = unitFile;
    this.health = health;         // optional {file, mustContain?, mustNotContain?, message}
    this.lastChange = Date.now();
    this.journal = [];
  }
  log(line) {
    this.journal.push({ t: Date.now(), line });
    if (this.journal.length > 200) this.journal.shift();
  }
}

class Host {
  constructor({ hostname, ip, latency = 5, up = true, provisionUsers = false, homeFiles = {}, role = 'generic' }) {
    if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(hostname)) throw new ConfigError('invalid hostname: ' + hostname);
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new ConfigError(hostname + ': invalid ip: ' + ip);
    this.hostname = hostname;
    this.ip = ip;
    this.latency = latency;
    this.up = up;
    this.provisionUsers = provisionUsers;
    this.homeFiles = homeFiles;
    this.role = role;               // 'base' | 'control-plane' | 'worker' | 'generic'
    this.network = null;
    this.users = new Map();
    this.nextUid = 1000;
    this.fs = new FileSystem();
    this.services = new Map();      // name -> Service
    this.packages = {};             // name -> installed version
    this.availablePackages = {};    // name -> [versions]
    this.heldPackages = new Set();
    this.kubeconfig = null;         // { contexts: {name: {cluster, namespace}}, current }
    this.node = null;               // {cluster, nodeName} when this host is a cluster node
    this.runningKubeletVersion = null;
    this.apparmor = new Set(['cri-containerd.apparmor.d']);   // loaded AppArmor profiles
    this.sysctl = { 'net.ipv4.ip_forward': 1, 'net.ipv4.conf.all.accept_redirects': 1, 'net.ipv4.conf.all.send_redirects': 1, 'net.ipv4.conf.all.accept_source_route': 0, 'kernel.dmesg_restrict': 0, 'kernel.kptr_restrict': 1, 'fs.protected_hardlinks': 1, 'net.bridge.bridge-nf-call-iptables': 1, 'vm.overcommit_memory': 1, 'kernel.panic': 10 };
    this.buildBaseFs();
  }

  buildBaseFs() {
    const fs = this.fs;
    fs.mkdir(['etc'], null);
    fs.mkdir(['home'], null);
    fs.mkdir(['tmp'], null, { mode: 0o777 });
    fs.mkdir(['opt'], null);
    fs.mkdir(['var'], null);
    fs.mkdir(['var', 'log'], null);
    fs.mkdir(['var', 'lib'], null);
    fs.writeFile(['etc', 'hostname'], this.hostname + '\n', null);
    fs.writeFile(['etc', 'os-release'], 'PRETTY_NAME="Ubuntu 22.04.4 LTS"\nNAME="Ubuntu"\nVERSION_ID="22.04"\n', null);
  }

  addUser(user) {
    if (this.users.has(user.name)) throw new ConfigError(this.hostname + ': duplicate user ' + user.name);
    if (user.uid === undefined) user.uid = this.nextUid++;
    this.users.set(user.name, user);
    const home = user.homeParts;
    if (!this.fs.exists(home, null)) this.fs.mkdir(home, null, { parents: true, mode: 0o750 });
    this.fs.node(home, null).owner = user.name;
    for (const [name, content] of Object.entries(this.homeFiles)) {
      const text = String(content);
      const f = this.fs.writeFile(home.concat([name]), text.endsWith('\n') ? text : text + '\n', null);
      f.owner = user.name;
    }
    return user;
  }

  provision(name) { return this.addUser(new User({ name })); }
  getUser(name) { return this.users.get(name) || null; }

  addService(name, opts) {
    const s = new Service(name, opts);
    this.services.set(name, s);
    return s;
  }
  service(name) { return this.services.get(name) || null; }

  /* A service can only run when its health precondition holds
     (e.g. a kubelet config file that must contain a given line). */
  serviceHealthProblem(svc) {
    if (!svc.health) return null;
    const h = svc.health;
    try {
      const text = this.fs.readFile(h.file.split('/').filter(Boolean), null);
      if (h.mustContain && !text.includes(h.mustContain)) return h.message || (h.file + ' is missing ' + JSON.stringify(h.mustContain));
      if (h.mustNotContain && text.includes(h.mustNotContain)) return h.message || (h.file + ' contains ' + JSON.stringify(h.mustNotContain));
    } catch (e) {
      return h.message || (h.file + ': no such file');
    }
    return null;
  }

  /* Write (or overwrite) a file as root with parents created. */
  seedFile(path, content, { owner = 'root', mode } = {}) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length > 1) this.fs.mkdir(parts.slice(0, -1), null, { parents: true });
    const f = this.fs.writeFile(parts, content, null);
    f.owner = owner;
    if (mode !== undefined) f.mode = mode;
    return f;
  }
  seedDir(path, { owner = 'root', mode = 0o755 } = {}) {
    const parts = path.split('/').filter(Boolean);
    const d = this.fs.mkdir(parts, null, { parents: true, mode });
    d.owner = owner;
    return d;
  }
}
