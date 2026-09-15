/* core/network.js — a Network is composed of Hosts. Networks are isolated
   from each other unless the Environment links them. */

class Network {
  constructor({ name, cidr = null }) {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) throw new ConfigError('invalid network name: ' + name);
    this.name = name;
    this.cidr = cidr;
    this.hosts = new Map();
  }

  attach(host) {
    if (this.hosts.has(host.hostname)) throw new ConfigError(this.name + ': duplicate host ' + host.hostname);
    host.network = this;
    this.hosts.set(host.hostname, host);
  }

  find(target) {
    if (this.hosts.has(target)) return this.hosts.get(target);
    for (const h of this.hosts.values()) if (h.ip === target) return h;
    return null;
  }
}
