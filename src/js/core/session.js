/* core/session.js — one user on one host. ssh/su/sudo push, exit pops.
   Carries shell environment variables (ETCDCTL_API=3 etc.). */

class Session {
  constructor(host, user, { env = {} } = {}) {
    this.host = host;
    this.user = user;
    this.cwd = user.homeParts.slice();
    if (!host.fs.exists(this.cwd, null)) this.cwd = [];
    this.env = Object.assign({ HOME: pathString(user.homeParts), USER: user.name, SHELL: '/bin/bash' }, env);
  }

  get fs() { return this.host.fs; }

  resolvePath(str) {
    let parts;
    if (str.startsWith('~')) {
      const rest = str.slice(1).replace(/^\//, '');
      parts = this.user.homeParts.concat(rest ? rest.split('/') : []);
    } else if (str.startsWith('/')) {
      parts = str.split('/').filter(Boolean);
    } else {
      parts = this.cwd.concat(str.split('/').filter(s => s.length));
    }
    const out = [];
    for (const p of parts) {
      if (p === '' || p === '.') continue;
      if (p === '..') { out.pop(); continue; }
      out.push(p);
    }
    return out;
  }

  displayCwd() {
    const home = this.user.homeParts;
    const c = this.cwd;
    if (c.length >= home.length && home.every((p, i) => c[i] === p)) {
      return '~' + (c.length > home.length ? '/' + c.slice(home.length).join('/') : '');
    }
    return pathString(c) || '/';
  }
}
