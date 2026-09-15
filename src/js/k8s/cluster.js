/* k8s/cluster.js — a Cluster holds every API object as a plain JSON
   object (like the real API server), applies kubectl-faithful defaults,
   allocates IPs, records events, cascades deletes through ownerReferences,
   and knows which Hosts are its nodes. Controllers live in sim.js. */

class ApiError extends ShellError {
  constructor(status, message) { super(message); this.status = status; }
  toString() { return 'Error from server (' + this.status + '): ' + this.message; }
}

class Cluster {
  constructor({ name, version = '1.31.0', podCidr = '10.244.0.0/16', serviceCidr = '10.96.0.0/12' }) {
    this.name = name;
    this.version = version;                 // control plane version
    this.podCidr = podCidr;
    this.serviceCidr = serviceCidr;
    this.kinds = new KindRegistry();
    this.store = new Map();                 // key -> object
    this.sim = new Map();                   // uid -> simulation state (never serialized)
    this.events = [];
    this.history = new Map();               // deployment key -> [{revision, template, cause, rsName}]
    this.nodeHosts = new Map();             // node name -> Host
    this.nodeOrder = [];
    this.rv = 1000;
    this.svcIpCounter = 100;
    this.podIpCounters = new Map();
    this.nodePortCounter = 30000;
    this.staticPodFlags = {};               // component -> Set of flags from the generated manifest
    this.createdAt = Date.now();
  }

  key(kind, ns, name) { return kind + '|' + (ns || '') + '|' + name; }
  keyOf(obj) { return this.key(obj.kind, obj.metadata.namespace, obj.metadata.name); }

  get(entry, ns, name) {
    return this.store.get(this.key(entry.kind, entry.namespaced ? ns : '', name)) || null;
  }
  getByKindName(kind, ns, name) {
    const entry = this.kinds.byKind(kind);
    return entry ? this.get(entry, ns, name) : null;
  }
  list(entry, ns) {
    const out = [];
    for (const obj of this.store.values()) {
      if (obj.kind !== entry.kind) continue;
      if (entry.namespaced && ns && obj.metadata.namespace !== ns) continue;
      out.push(obj);
    }
    return out.sort((a, b) => (a.metadata.namespace || '').localeCompare(b.metadata.namespace || '') || a.metadata.name.localeCompare(b.metadata.name));
  }
  all() { return [...this.store.values()]; }
  namespaceExists(ns) { return this.store.has(this.key('Namespace', '', ns)); }
  nodes() { return this.list(this.kinds.resolve('node')); }
  node(name) { return this.store.get(this.key('Node', '', name)) || null; }
  bindNodeHost(name, host) { this.nodeHosts.set(name, host); host.node = { cluster: this, nodeName: name }; }
  nodeHost(name) { return this.nodeHosts.get(name) || null; }
  controlPlaneNodes() { return this.nodes().filter(n => n.metadata.labels && 'node-role.kubernetes.io/control-plane' in n.metadata.labels); }

  simState(obj) {
    let s = this.sim.get(obj.metadata.uid);
    if (!s) { s = { createdAt: Date.parse(obj.metadata.creationTimestamp) || Date.now() }; this.sim.set(obj.metadata.uid, s); }
    return s;
  }

  /* ---------- create / update / delete ---------- */

  entryFor(obj) {
    if (!obj || typeof obj !== 'object') throw new ApiError('BadRequest', 'object is not a valid Kubernetes resource');
    if (!obj.kind) throw new ApiError('BadRequest', 'Object \'Kind\' is missing');
    const entry = this.kinds.byKind(obj.kind, obj.apiVersion);
    if (!entry) throw new ApiError('NotFound', 'the server could not find the requested resource (kind ' + obj.kind + ')');
    return entry;
  }

  create(obj, { sim = {}, defaultNamespace = 'default', now = Date.now() } = {}) {
    obj = deepClone(obj);
    const entry = this.entryFor(obj);
    obj.apiVersion = obj.apiVersion || entry.apiVersion;
    obj.metadata = obj.metadata || {};
    const md = obj.metadata;
    if (!md.name && md.generateName) md.name = md.generateName + randSuffix(5);
    if (!md.name) throw new ApiError('Invalid', entry.kind + ' "" is invalid: metadata.name: Required value: name or generateName is required');
    const looseName = ['Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding'].includes(entry.kind);
    if (!(looseName ? /^[a-zA-Z0-9:._-]+$/ : /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/).test(md.name) || md.name.length > 253) {
      throw new ApiError('Invalid', entry.kind + ' "' + md.name + '" is invalid: metadata.name: Invalid value: "' + md.name + '": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, \'-\' or \'.\'');
    }
    if (entry.namespaced) {
      md.namespace = md.namespace || defaultNamespace;
      if (!this.namespaceExists(md.namespace)) throw new ApiError('NotFound', 'namespaces "' + md.namespace + '" not found');
    } else {
      delete md.namespace;
    }
    if (this.store.has(this.keyOf(obj))) {
      throw new ApiError('AlreadyExists', entry.plural + ' "' + md.name + '" already exists');
    }
    md.uid = md.uid || randomUid();
    md.creationTimestamp = md.creationTimestamp || new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');
    md.resourceVersion = String(this.rv++);
    md.labels = md.labels || {};
    md.annotations = md.annotations || {};
    if (!Object.keys(md.annotations).length) delete md.annotations;
    if (!Object.keys(md.labels).length) delete md.labels;
    this.applyDefaults(obj, entry);
    this.validate(obj, entry);
    this.store.set(this.keyOf(obj), obj);
    const st = this.simState(obj);
    Object.assign(st, sim, { createdAt: Date.parse(md.creationTimestamp) });
    this.onCreated(obj, entry);
    return obj;
  }

  update(obj) {
    const entry = this.entryFor(obj);
    const existing = this.get(entry, obj.metadata.namespace, obj.metadata.name);
    if (!existing) throw new ApiError('NotFound', entry.plural + ' "' + obj.metadata.name + '" not found');
    const next = deepClone(obj);
    next.apiVersion = next.apiVersion || entry.apiVersion;
    next.metadata.uid = existing.metadata.uid;
    next.metadata.creationTimestamp = existing.metadata.creationTimestamp;
    next.metadata.resourceVersion = String(this.rv++);
    if (existing.metadata.generation !== undefined) {
      next.metadata.generation = JSON.stringify(existing.spec) === JSON.stringify(next.spec) ? existing.metadata.generation : existing.metadata.generation + 1;
    }
    if (next.metadata.labels && !Object.keys(next.metadata.labels).length) delete next.metadata.labels;
    if (next.metadata.annotations && !Object.keys(next.metadata.annotations).length) delete next.metadata.annotations;
    this.applyDefaults(next, entry);
    this.validate(next, entry);
    if (entry.kind === 'Pod') this.validatePodUpdate(existing, next);
    if (entry.kind === 'Service' && next.spec.clusterIP === undefined) next.spec.clusterIP = existing.spec.clusterIP;
    this.store.set(this.keyOf(next), next);
    return next;
  }

  /* Returns {obj, action: 'created' | 'configured' | 'unchanged'} */
  apply(obj, opts) {
    const entry = this.entryFor(obj);
    const ns = entry.namespaced ? (obj.metadata && obj.metadata.namespace) || (opts && opts.defaultNamespace) || 'default' : undefined;
    const existing = this.get(entry, ns, obj.metadata && obj.metadata.name);
    if (!existing) return { obj: this.create(obj, opts), action: 'created' };
    const merged = deepClone(existing);
    const incoming = deepClone(obj);
    incoming.metadata = incoming.metadata || {};
    // apply semantics: incoming spec replaces, metadata labels/annotations merge, status kept
    for (const k of Object.keys(incoming)) {
      if (k === 'metadata' || k === 'status') continue;
      merged[k] = incoming[k];
    }
    merged.metadata.labels = Object.assign({}, existing.metadata.labels || {}, incoming.metadata.labels || {});
    merged.metadata.annotations = Object.assign({}, existing.metadata.annotations || {}, incoming.metadata.annotations || {});
    delete merged.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
    const before = JSON.stringify(this.stripVolatile(existing));
    const updated = this.update(merged);
    const after = JSON.stringify(this.stripVolatile(updated));
    return { obj: updated, action: before === after ? 'unchanged' : 'configured' };
  }

  stripVolatile(obj) {
    const c = deepClone(obj);
    delete c.metadata.resourceVersion; delete c.metadata.generation; delete c.status;
    return c;
  }

  delete(entry, ns, name, { cascade = true } = {}) {
    const obj = this.get(entry, ns, name);
    if (!obj) throw new ApiError('NotFound', entry.plural + ' "' + name + '" not found');
    this.removeObject(obj, cascade);
    return obj;
  }

  removeObject(obj, cascade) {
    this.store.delete(this.keyOf(obj));
    this.sim.delete(obj.metadata.uid);
    if (obj.kind === 'Namespace') {
      for (const o of this.all()) if (o.metadata.namespace === obj.metadata.name) this.removeObject(o, false);
    }
    if (obj.kind === 'Service' && obj.spec.clusterIP && obj.spec.clusterIP !== 'None') this.freeServiceIp(obj.spec.clusterIP);
    if (cascade) {
      for (const o of this.all()) {
        if ((o.metadata.ownerReferences || []).some(r => r.uid === obj.metadata.uid)) this.removeObject(o, true);
      }
    }
    if (obj.kind === 'CustomResourceDefinition') this.unregisterCrd(obj);
  }

  validatePodUpdate(existing, next) {
    const a = deepClone(existing.spec), b = deepClone(next.spec);
    for (const s of [a, b]) {
      delete s.activeDeadlineSeconds; delete s.tolerations;
      (s.containers || []).forEach(c => { delete c.image; });
      (s.initContainers || []).forEach(c => { delete c.image; });
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new ApiError('Invalid', 'Pod "' + next.metadata.name + '" is invalid: spec: Forbidden: pod updates may not change fields other than `spec.containers[*].image`, `spec.initContainers[*].image`, `spec.activeDeadlineSeconds`, `spec.tolerations` (only additions to existing tolerations) or `spec.terminationGracePeriodSeconds`');
    }
  }

  /* ---------- defaults & validation ---------- */

  applyDefaults(obj, entry) {
    obj.spec = obj.spec === undefined && !['ConfigMap', 'Secret', 'ServiceAccount', 'Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding', 'StorageClass', 'PriorityClass', 'Endpoints', 'Event', 'Namespace'].includes(entry.kind) ? {} : obj.spec;
    const md = obj.metadata;
    switch (entry.kind) {
      case 'Pod': this.podDefaults(obj.spec); break;
      case 'Deployment': case 'ReplicaSet': case 'StatefulSet': case 'DaemonSet': {
        md.generation = md.generation || 1;
        const s = obj.spec;
        if (entry.kind !== 'DaemonSet' && s.replicas === undefined) s.replicas = 1;
        s.template = s.template || { metadata: {}, spec: {} };
        s.template.metadata = s.template.metadata || {};
        s.template.spec = s.template.spec || {};
        this.podDefaults(s.template.spec);
        if (entry.kind === 'Deployment') {
          s.strategy = s.strategy || { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' } };
          if (s.strategy.type === 'RollingUpdate' && !s.strategy.rollingUpdate) s.strategy.rollingUpdate = { maxSurge: '25%', maxUnavailable: '25%' };
          if (s.progressDeadlineSeconds === undefined) s.progressDeadlineSeconds = 600;
          if (s.revisionHistoryLimit === undefined) s.revisionHistoryLimit = 10;
        }
        if (entry.kind === 'DaemonSet') {
          s.updateStrategy = s.updateStrategy || { type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } };
          if (s.revisionHistoryLimit === undefined) s.revisionHistoryLimit = 10;
        }
        if (entry.kind === 'StatefulSet') {
          s.updateStrategy = s.updateStrategy || { type: 'RollingUpdate', rollingUpdate: { partition: 0 } };
          s.podManagementPolicy = s.podManagementPolicy || 'OrderedReady';
          if (s.revisionHistoryLimit === undefined) s.revisionHistoryLimit = 10;
          s.serviceName = s.serviceName || '';
        }
        break;
      }
      case 'Job': {
        md.generation = md.generation || 1;
        const s = obj.spec;
        if (s.parallelism === undefined) s.parallelism = 1;
        if (s.completions === undefined) s.completions = 1;
        if (s.backoffLimit === undefined) s.backoffLimit = 6;
        s.completionMode = s.completionMode || 'NonIndexed';
        s.suspend = !!s.suspend;
        s.template = s.template || { metadata: {}, spec: {} };
        s.template.metadata = s.template.metadata || {};
        s.template.spec = s.template.spec || {};
        if (!s.template.spec.restartPolicy) s.template.spec.restartPolicy = 'Never';
        this.podDefaults(s.template.spec);
        const cuid = md.uid;
        s.selector = s.selector || { matchLabels: { 'batch.kubernetes.io/controller-uid': cuid } };
        s.template.metadata.labels = Object.assign({ 'batch.kubernetes.io/controller-uid': cuid, 'batch.kubernetes.io/job-name': md.name, 'controller-uid': cuid, 'job-name': md.name }, s.template.metadata.labels || {});
        break;
      }
      case 'CronJob': {
        md.generation = md.generation || 1;
        const s = obj.spec;
        s.concurrencyPolicy = s.concurrencyPolicy || 'Allow';
        s.suspend = !!s.suspend;
        if (s.successfulJobsHistoryLimit === undefined) s.successfulJobsHistoryLimit = 3;
        if (s.failedJobsHistoryLimit === undefined) s.failedJobsHistoryLimit = 1;
        s.jobTemplate = s.jobTemplate || { spec: { template: { spec: {} } } };
        break;
      }
      case 'Service': {
        const s = obj.spec;
        s.type = s.type || 'ClusterIP';
        s.sessionAffinity = s.sessionAffinity || 'None';
        if (s.type !== 'ExternalName') {
          if (s.clusterIP === undefined) s.clusterIP = this.allocServiceIp();
          s.clusterIPs = s.clusterIPs || [s.clusterIP];
          s.ipFamilies = s.ipFamilies || ['IPv4'];
          s.ipFamilyPolicy = s.ipFamilyPolicy || 'SingleStack';
          s.internalTrafficPolicy = s.internalTrafficPolicy || 'Cluster';
        }
        for (const p of s.ports || []) {
          p.protocol = p.protocol || 'TCP';
          if (p.targetPort === undefined) p.targetPort = p.port;
          if ((s.type === 'NodePort' || s.type === 'LoadBalancer') && !p.nodePort) p.nodePort = this.nodePortCounter++;
        }
        if (s.type === 'LoadBalancer') s.externalTrafficPolicy = s.externalTrafficPolicy || 'Cluster';
        if (s.type === 'NodePort') s.externalTrafficPolicy = s.externalTrafficPolicy || 'Cluster';
        break;
      }
      case 'Namespace':
        obj.spec = obj.spec || { finalizers: ['kubernetes'] };
        obj.status = { phase: 'Active' };
        break;
      case 'Secret':
        obj.type = obj.type || 'Opaque';
        if (obj.stringData) {
          obj.data = obj.data || {};
          for (const [k, v] of Object.entries(obj.stringData)) obj.data[k] = btoa(unescape(encodeURIComponent(String(v))));
          delete obj.stringData;
        }
        break;
      case 'PersistentVolume': {
        const s = obj.spec;
        s.persistentVolumeReclaimPolicy = s.persistentVolumeReclaimPolicy || 'Retain';
        s.volumeMode = s.volumeMode || 'Filesystem';
        obj.status = obj.status && obj.status.phase ? obj.status : { phase: 'Available' };
        break;
      }
      case 'PersistentVolumeClaim': {
        const s = obj.spec;
        s.volumeMode = s.volumeMode || 'Filesystem';
        obj.status = obj.status && obj.status.phase ? obj.status : { phase: 'Pending' };
        break;
      }
      case 'StorageClass':
        obj.reclaimPolicy = obj.reclaimPolicy || 'Delete';
        obj.volumeBindingMode = obj.volumeBindingMode || 'Immediate';
        break;
      case 'NetworkPolicy': {
        const s = obj.spec;
        s.podSelector = s.podSelector || {};
        if (!s.policyTypes) {
          s.policyTypes = ['Ingress'];
          if (s.egress) s.policyTypes.push('Egress');
        }
        break;
      }
      case 'HorizontalPodAutoscaler':
        if (obj.spec.minReplicas === undefined) obj.spec.minReplicas = 1;
        break;
      case 'CustomResourceDefinition':
        this.registerCrd(obj);
        break;
      default: break;
    }
  }

  podDefaults(spec) {
    if (!spec) return;
    spec.restartPolicy = spec.restartPolicy || 'Always';
    spec.dnsPolicy = spec.dnsPolicy || 'ClusterFirst';
    if (spec.terminationGracePeriodSeconds === undefined) spec.terminationGracePeriodSeconds = 30;
    spec.schedulerName = spec.schedulerName || 'default-scheduler';
    spec.securityContext = spec.securityContext || {};
    if (spec.enableServiceLinks === undefined) spec.enableServiceLinks = true;
    if (spec.preemptionPolicy === undefined) spec.preemptionPolicy = 'PreemptLowerPriority';
    if (spec.priority === undefined) spec.priority = 0;
    spec.serviceAccountName = spec.serviceAccountName || spec.serviceAccount || 'default';
    spec.serviceAccount = spec.serviceAccountName;
    for (const c of [...(spec.containers || []), ...(spec.initContainers || [])]) {
      if (!c.imagePullPolicy) c.imagePullPolicy = (!c.image || c.image.endsWith(':latest') || !c.image.includes(':')) ? 'Always' : 'IfNotPresent';
      c.resources = c.resources || {};
      c.terminationMessagePath = c.terminationMessagePath || '/dev/termination-log';
      c.terminationMessagePolicy = c.terminationMessagePolicy || 'File';
      for (const p of c.ports || []) p.protocol = p.protocol || 'TCP';
    }
  }

  validate(obj, entry) {
    const md = obj.metadata;
    const podSpec = entry.kind === 'Pod' ? obj.spec : ['Deployment', 'ReplicaSet', 'DaemonSet', 'StatefulSet', 'Job'].includes(entry.kind) ? obj.spec.template.spec : null;
    if (podSpec) {
      const prefix = entry.kind === 'Pod' ? 'spec' : 'spec.template.spec';
      if (!podSpec.containers || !podSpec.containers.length) {
        throw new ApiError('Invalid', entry.kind + ' "' + md.name + '" is invalid: ' + prefix + '.containers: Required value');
      }
      podSpec.containers.forEach((c, i) => {
        if (!c.name) throw new ApiError('Invalid', entry.kind + ' "' + md.name + '" is invalid: ' + prefix + '.containers[' + i + '].name: Required value');
        if (!c.image) throw new ApiError('Invalid', entry.kind + ' "' + md.name + '" is invalid: ' + prefix + '.containers[' + i + '].image: Required value');
      });
    }
    if (['Deployment', 'ReplicaSet', 'DaemonSet', 'StatefulSet'].includes(entry.kind)) {
      const sel = obj.spec.selector;
      if (!sel || (!sel.matchLabels && !sel.matchExpressions)) {
        throw new ApiError('Invalid', entry.kind + ' "' + md.name + '" is invalid: spec.selector: Required value');
      }
      const tl = obj.spec.template.metadata.labels || {};
      if (sel.matchLabels && !Object.entries(sel.matchLabels).every(([k, v]) => tl[k] === v)) {
        throw new ApiError('Invalid', entry.kind + ' "' + md.name + '" is invalid: spec.template.metadata.labels: Invalid value: ' + JSON.stringify(tl) + ': `selector` does not match template `labels`');
      }
    }
    if (entry.kind === 'Pod') this.enforcePodSecurity(obj);
    if (entry.kind === 'Service' && obj.spec.type !== 'ExternalName' && !(obj.spec.ports && obj.spec.ports.length)) {
      throw new ApiError('Invalid', 'Service "' + md.name + '" is invalid: spec.ports: Required value');
    }
  }

  /* Pod Security Admission: namespaces labelled pod-security.kubernetes.io/enforce=baseline|restricted reject violating pods. */
  enforcePodSecurity(pod) {
    const nsObj = this.getByKindName('Namespace', null, pod.metadata.namespace);
    const level = nsObj && nsObj.metadata.labels && nsObj.metadata.labels['pod-security.kubernetes.io/enforce'];
    if (level !== 'baseline' && level !== 'restricted') return;
    const spec = pod.spec, v = [];
    if (spec.hostNetwork) v.push('host namespaces (hostNetwork=true)');
    if (spec.hostPID) v.push('host namespaces (hostPID=true)');
    if (spec.hostIPC) v.push('host namespaces (hostIPC=true)');
    for (const vol of spec.volumes || []) if (vol.hostPath) v.push('hostPath volumes (volume "' + vol.name + '")');
    const podSc = spec.securityContext || {};
    for (const c of [...(spec.containers || []), ...(spec.initContainers || [])]) {
      const sc = c.securityContext || {};
      if (sc.privileged) v.push('privileged (container "' + c.name + '" must not set securityContext.privileged=true)');
      if ((c.ports || []).some(p => p.hostPort)) v.push('hostPort (container "' + c.name + '" uses hostPort)');
      if (level === 'restricted') {
        if (sc.allowPrivilegeEscalation !== false) v.push('allowPrivilegeEscalation != false (container "' + c.name + '" must set securityContext.allowPrivilegeEscalation=false)');
        if (!(sc.capabilities && (sc.capabilities.drop || []).includes('ALL'))) v.push('unrestricted capabilities (container "' + c.name + '" must set securityContext.capabilities.drop=["ALL"])');
        if (!(sc.runAsNonRoot === true || (podSc.runAsNonRoot === true && sc.runAsNonRoot !== false))) v.push('runAsNonRoot != true (pod or container "' + c.name + '" must set securityContext.runAsNonRoot=true)');
        const seccomp = ((sc.seccompProfile || podSc.seccompProfile) || {}).type;
        if (seccomp !== 'RuntimeDefault' && seccomp !== 'Localhost') v.push('seccompProfile (pod or container "' + c.name + '" must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost")');
      }
    }
    if (v.length) throw new ApiError('Forbidden', 'pods "' + pod.metadata.name + '" is forbidden: violates PodSecurity "' + level + ':latest": ' + [...new Set(v)].join(', '));
  }

  onCreated(obj, entry) {
    if (entry.kind === 'Pod') {
      const st = this.simState(obj);
      if (obj.spec.nodeName) st.scheduledAt = st.createdAt;
    }
    if (entry.kind === 'Namespace') {
      const ts = obj.metadata.creationTimestamp;
      this.create({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'default', namespace: obj.metadata.name, creationTimestamp: ts } });
      this.create({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'kube-root-ca.crt', namespace: obj.metadata.name, creationTimestamp: ts, annotations: { 'kubernetes.io/description': 'Contains a CA bundle that can be used to verify the kube-apiserver when using internal endpoints such as the internal service IP or kubernetes.default.svc.' } }, data: { 'ca.crt': '-----BEGIN CERTIFICATE-----\nMIIDBTCCAe2gAwIBAgIIQ' + shortHash(obj.metadata.name, 40) + '\n-----END CERTIFICATE-----\n' } });
    }
  }

  /* ---------- CRDs ---------- */
  registerCrd(crd) {
    const s = crd.spec || {};
    const names = s.names || {};
    const v = (s.versions || []).find(x => x.served !== false) || s.versions?.[0] || { name: 'v1' };
    this.kinds.add({
      kind: names.kind, plural: names.plural, singular: names.singular || (names.kind || '').toLowerCase(),
      short: names.shortNames || [], group: s.group, version: v.name, namespaced: s.scope !== 'Cluster', custom: true,
    });
  }
  unregisterCrd(crd) {
    const kind = crd.spec && crd.spec.names && crd.spec.names.kind;
    this.kinds.kinds = this.kinds.kinds.filter(k => !(k.custom && k.kind === kind));
  }

  /* ---------- IPs ---------- */
  allocServiceIp() {
    const n = this.svcIpCounter++;
    return '10.' + (96 + (n >> 16)) + '.' + ((n >> 8) & 255) + '.' + (n & 255);
  }
  freeServiceIp() { /* addresses are not reused; fine for an exam */ }
  allocPodIp(nodeName) {
    let idx = this.nodeOrder.indexOf(nodeName);
    if (idx === -1) { this.nodeOrder.push(nodeName); idx = this.nodeOrder.length - 1; }
    const c = (this.podIpCounters.get(nodeName) || 1) + 1;
    this.podIpCounters.set(nodeName, c);
    return '10.244.' + idx + '.' + (c % 250 + 2);
  }

  /* ---------- events ---------- */
  addEvent(obj, { type = 'Normal', reason, message, source = 'kubelet' }) {
    const last = this.events.find(e => e.involvedObject.uid === obj.metadata.uid && e.reason === reason && e.message === message);
    if (last) { last.count++; last.lastTimestamp = new Date().toISOString(); return last; }
    const ev = {
      type, reason, message, source, count: 1,
      firstTimestamp: new Date().toISOString(), lastTimestamp: new Date().toISOString(),
      involvedObject: { kind: obj.kind, name: obj.metadata.name, namespace: obj.metadata.namespace, uid: obj.metadata.uid },
    };
    this.events.push(ev);
    if (this.events.length > 500) this.events.shift();
    return ev;
  }
  eventsFor(obj) { return this.events.filter(e => e.involvedObject.uid === obj.metadata.uid); }

  /* ---------- control plane health (read from the control-plane host) ---------- */

  staticPodProblem(component) {
    const cp = this.controlPlaneNodes()[0];
    const host = cp && this.nodeHost(cp.metadata.name);
    if (!host) return null;
    let text;
    try { text = host.fs.readFile(['etc', 'kubernetes', 'manifests', component + '.yaml'], null); }
    catch (e) { return 'manifest missing'; }
    let doc;
    try { doc = YAML.parse(text); } catch (e) { return 'manifest invalid: ' + e.message; }
    if (!doc || doc.kind !== 'Pod' || !doc.spec || !doc.spec.containers || !doc.spec.containers[0]) return 'manifest invalid: not a Pod';
    const c = doc.spec.containers[0];
    const cmd = c.command || [];
    if (cmd[0] !== component) return 'container command must start with ' + component;
    const tag = String(c.image || '').split(':').pop();
    if (!/^(v?\d+\.\d+\.\d+|\d+\.\d+\.\d+-\d+)$/.test(tag) || /broken|bad|nonexistent/.test(String(c.image))) return 'image not found: ' + c.image;
    const known = this.staticPodFlags[component];
    if (known) {
      for (const a of cmd.slice(1)) {
        const flag = String(a).split('=')[0];
        if (!flag.startsWith('--') || !known.has(flag)) return 'unknown flag ' + flag;
      }
    }
    return null;
  }

  apiHealthy() {
    const cp = this.controlPlaneNodes()[0];
    const host = cp && this.nodeHost(cp.metadata.name);
    if (!host) return { ok: true };
    const addr = host.ip + ':6443';
    const kubelet = host.service('kubelet');
    if (kubelet && !kubelet.active) return { ok: false, message: 'The connection to the server ' + addr + ' was refused - did you specify the right host or port?' };
    if (this.staticPodProblem('etcd')) return { ok: false, message: 'Error from server (InternalError): etcdserver: request timed out' };
    if (this.staticPodProblem('kube-apiserver')) return { ok: false, message: 'The connection to the server ' + addr + ' was refused - did you specify the right host or port?' };
    return { ok: true };
  }
  schedulerHealthy() { return !this.staticPodProblem('kube-scheduler'); }
  controllerManagerHealthy() { return !this.staticPodProblem('kube-controller-manager'); }
}
