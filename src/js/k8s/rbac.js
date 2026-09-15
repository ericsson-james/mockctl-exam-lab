/* k8s/rbac.js — RBAC evaluation (auth can-i), NetworkPolicy evaluation
   (used by simulated connectivity checks), and in-cluster DNS. */

const Rbac = {
  subjectMatches(subject, who) {
    if (subject.kind === 'User') return subject.name === who.user;
    if (subject.kind === 'Group') return (who.groups || []).includes(subject.name);
    if (subject.kind === 'ServiceAccount') return who.sa === (subject.namespace || 'default') + ':' + subject.name;
    return false;
  },
  rulesAllow(rules, verb, resource, name) {
    for (const r of rules || []) {
      const verbs = r.verbs || [];
      const resources = r.resources || [];
      const verbOk = verbs.includes('*') || verbs.includes(verb);
      const resOk = resources.includes('*') || resources.includes(resource) || resources.some(x => x.split('/')[0] === resource);
      const nameOk = !r.resourceNames || !r.resourceNames.length || (name && r.resourceNames.includes(name));
      if (verbOk && resOk && nameOk) return true;
    }
    return false;
  },
  /* who: {user, groups, sa: 'ns:name'} — resource is the plural name. */
  canI(cluster, who, verb, resource, ns, name) {
    if ((who.groups || []).includes('system:masters')) return true;
    const roleOf = (ref, bindingNs) => {
      if (ref.kind === 'ClusterRole') return cluster.getByKindName('ClusterRole', null, ref.name);
      return cluster.getByKindName('Role', bindingNs, ref.name);
    };
    for (const crb of cluster.list(cluster.kinds.resolve('clusterrolebinding'), null)) {
      if (!(crb.subjects || []).some(s => Rbac.subjectMatches(s, who))) continue;
      const role = roleOf(crb.roleRef, null);
      if (role && Rbac.rulesAllow(role.rules, verb, resource, name)) return true;
    }
    if (ns) {
      for (const rb of cluster.list(cluster.kinds.resolve('rolebinding'), ns)) {
        if (!(rb.subjects || []).some(s => Rbac.subjectMatches(s, who))) continue;
        const role = roleOf(rb.roleRef, ns);
        if (role && Rbac.rulesAllow(role.rules, verb, resource, name)) return true;
      }
    }
    return false;
  },
};

const NetPol = {
  policiesSelecting(cluster, pod, type) {
    return cluster.list(cluster.kinds.resolve('netpol'), pod.metadata.namespace)
      .filter(np => (np.spec.policyTypes || ['Ingress']).includes(type) && labelsMatch(np.spec.podSelector || {}, pod.metadata.labels));
  },
  ipToInt(ip) { return ip.split('.').reduce((n, o) => (n << 8) + parseInt(o, 10), 0) >>> 0; },
  inCidr(ip, cidr) {
    const [base, bitsStr] = String(cidr).split('/');
    const bits = bitsStr === undefined ? 32 : parseInt(bitsStr, 10);
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || !/^\d{1,3}(\.\d{1,3}){3}$/.test(base)) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (NetPol.ipToInt(ip) & mask) === (NetPol.ipToInt(base) & mask);
  },
  peerMatches(cluster, peer, otherPod, policyNs) {
    if (peer.ipBlock) {
      const ip = otherPod.status && otherPod.status.podIP;
      if (!ip) return false;
      return NetPol.inCidr(ip, peer.ipBlock.cidr) && !(peer.ipBlock.except || []).some(e => NetPol.inCidr(ip, e));
    }
    const nsObj = cluster.getByKindName('Namespace', null, otherPod.metadata.namespace);
    const nsLabels = Object.assign({ 'kubernetes.io/metadata.name': otherPod.metadata.namespace }, nsObj && nsObj.metadata.labels || {});
    if (peer.namespaceSelector && peer.podSelector) {
      return labelsMatch(peer.namespaceSelector, nsLabels) && labelsMatch(peer.podSelector, otherPod.metadata.labels);
    }
    if (peer.namespaceSelector) return labelsMatch(peer.namespaceSelector, nsLabels);
    if (peer.podSelector) return otherPod.metadata.namespace === policyNs && labelsMatch(peer.podSelector, otherPod.metadata.labels);
    return false;
  },
  portMatches(ports, port) {
    if (!ports || !ports.length) return true;
    return ports.some(p => p.port === undefined || String(p.port) === String(port) || (p.endPort && port >= p.port && port <= p.endPort));
  },
  /* Returns {allowed, reason} for traffic from -> to on port. */
  allowed(cluster, fromPod, toPod, port) {
    const ingress = NetPol.policiesSelecting(cluster, toPod, 'Ingress');
    if (ingress.length) {
      const ok = ingress.some(np => (np.spec.ingress || []).some(rule =>
        NetPol.portMatches(rule.ports, port) && (!rule.from || !rule.from.length || rule.from.some(peer => NetPol.peerMatches(cluster, peer, fromPod, np.metadata.namespace)))));
      if (!ok) return { allowed: false, reason: 'ingress denied by NetworkPolicy ' + ingress.map(n => n.metadata.name).join(',') };
    }
    const egress = NetPol.policiesSelecting(cluster, fromPod, 'Egress');
    if (egress.length) {
      const ok = egress.some(np => (np.spec.egress || []).some(rule =>
        NetPol.portMatches(rule.ports, port) && (!rule.to || !rule.to.length || rule.to.some(peer => NetPol.peerMatches(cluster, peer, toPod, np.metadata.namespace)))));
      if (!ok) return { allowed: false, reason: 'egress denied by NetworkPolicy ' + egress.map(n => n.metadata.name).join(',') };
    }
    return { allowed: true };
  },
  /* DNS lookups to port 53 in kube-system are allowed by egress policies that mention it. */
  dnsAllowed(cluster, fromPod) {
    const egress = NetPol.policiesSelecting(cluster, fromPod, 'Egress');
    if (!egress.length) return true;
    return egress.some(np => (np.spec.egress || []).some(rule => NetPol.portMatches(rule.ports, 53) && (!rule.to || !rule.to.length || rule.to.some(p => p.namespaceSelector))));
  },
};

const DNS = {
  /* Resolve 'svc', 'svc.ns', 'svc.ns.svc', 'svc.ns.svc.cluster.local', or a pod IP. */
  resolve(cluster, name, fromNs) {
    const host = name.replace(/\.$/, '');
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      const svc = cluster.list(cluster.kinds.resolve('svc'), null).find(s => s.spec.clusterIP === host);
      if (svc) return { service: svc, ip: host };
      const pod = cluster.list(cluster.kinds.resolve('pod'), null).find(p => p.status && p.status.podIP === host);
      if (pod) return { pod, ip: host };
      return null;
    }
    const parts = host.split('.');
    let svcName = parts[0], ns = fromNs;
    if (parts.length >= 2 && parts[1] !== 'svc') ns = parts[1];
    if (parts.length >= 2 && parts[1] === 'svc') ns = fromNs;
    if (host === 'kubernetes' || host === 'kubernetes.default' || host.startsWith('kubernetes.default.svc')) { svcName = 'kubernetes'; ns = 'default'; }
    const svc = cluster.getByKindName('Service', ns, svcName);
    if (!svc) return null;
    return { service: svc, ip: svc.spec.clusterIP, fqdn: svcName + '.' + ns + '.svc.cluster.local' };
  },
};
