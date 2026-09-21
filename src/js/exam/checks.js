/* exam/checks.js — the declarative check DSL exam questions are graded
   with. Each check type is a function (world, spec) -> {pass, detail}.
   New exam types (CKS...) extend this by registering more types. */

const Checks = {
  types: {},
  register(type, fn) { Checks.types[type] = fn; },

  run(world, check) {
    const fn = Checks.types[check.type];
    if (!fn) return { pass: false, detail: 'unknown check type: ' + check.type };
    try {
      const r = fn(world, check);
      return { pass: !!r.pass, detail: r.detail || '' };
    } catch (e) {
      return { pass: false, detail: 'check error: ' + e.message };
    }
  },

  cluster(world, spec) {
    const c = world.clusters.get(spec.cluster || [...world.clusters.keys()][0]);
    if (!c) throw new Error('unknown cluster ' + spec.cluster);
    Sim.reconcile(c);
    return c;
  },
  host(world, spec) {
    const h = world.hosts.get(spec.host);
    if (!h) throw new Error('unknown host ' + spec.host);
    return h;
  },
  entry(cluster, kind) {
    const e = cluster.kinds.resolve(kind);
    if (!e) throw new Error('unknown kind ' + kind);
    return e;
  },
  find(cluster, spec) {
    const entry = Checks.entry(cluster, spec.kind);
    if (spec.name) return { entry, objs: [cluster.get(entry, spec.namespace, spec.name)].filter(Boolean) };
    let objs = cluster.list(entry, spec.namespace || null);
    if (spec.selector) objs = objs.filter(o => labelsMatch(parseLabelSelector(spec.selector), o.metadata.labels));
    return { entry, objs };
  },

  /* Assertion helper: value vs expectation (literal or operator object). */
  assertValue(actual, expected) {
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('exists' in expected) return (actual !== undefined) === !!expected.exists;
      if ('matches' in expected) return new RegExp(expected.matches).test(String(actual));
      if ('contains' in expected) return Array.isArray(actual) ? actual.some(x => JSON.stringify(x) === JSON.stringify(expected.contains) || x === expected.contains) : String(actual).includes(String(expected.contains));
      if ('notContains' in expected) return actual === undefined || (Array.isArray(actual) ? !actual.some(x => JSON.stringify(x) === JSON.stringify(expected.notContains) || x === expected.notContains || (typeof x === 'string' && x.includes(String(expected.notContains)))) : !String(actual).includes(String(expected.notContains)));
      if ('includesAll' in expected) return Array.isArray(actual) && expected.includesAll.every(v => actual.includes(v));
      if ('gte' in expected) return parseQuantity(actual) >= parseQuantity(expected.gte) || Number(actual) >= Number(expected.gte);
      if ('lte' in expected) return parseQuantity(actual) <= parseQuantity(expected.lte) || Number(actual) <= Number(expected.lte);
      if ('in' in expected) return expected.in.some(v => JSON.stringify(v) === JSON.stringify(actual));
      if ('length' in expected) return Array.isArray(actual) && actual.length === expected.length;
      if ('anyMatch' in expected) return Array.isArray(actual) && actual.some(item => Object.entries(expected.anyMatch).every(([p, v]) => Checks.assertValue(getPath(item, p), v)));
      if ('noneMatch' in expected) return !Array.isArray(actual) || !actual.some(item => Object.entries(expected.noneMatch).every(([p, v]) => Checks.assertValue(getPath(item, p), v)));
      return JSON.stringify(actual) === JSON.stringify(expected);
    }
    if (Array.isArray(expected)) return JSON.stringify(actual) === JSON.stringify(expected);
    return actual === expected || String(actual) === String(expected);
  },
  assertAll(obj, asserts) {
    const failed = [];
    for (const [path, expected] of Object.entries(asserts || {})) {
      if (!Checks.assertValue(getPath(obj, path), expected)) failed.push(path + ' is ' + JSON.stringify(getPath(obj, path)) + ', expected ' + JSON.stringify(expected));
    }
    return failed;
  },
};

Checks.register('resource', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  const { entry, objs } = Checks.find(cluster, spec);
  const wantExists = spec.exists !== false;
  if (!objs.length) return { pass: !wantExists, detail: wantExists ? entry.kind + ' ' + (spec.namespace ? spec.namespace + '/' : '') + (spec.name || spec.selector) + ' not found' : '' };
  if (!wantExists) return { pass: false, detail: entry.kind + ' ' + (spec.name || spec.selector) + ' still exists' };
  if (spec.count !== undefined && objs.length !== spec.count) return { pass: false, detail: 'expected ' + spec.count + ' ' + entry.plural + ', found ' + objs.length };
  if (spec.minCount !== undefined && objs.length < spec.minCount) return { pass: false, detail: 'expected at least ' + spec.minCount + ' ' + entry.plural + ', found ' + objs.length };
  const mode = spec.match || 'all';
  const results = objs.map(o => Checks.assertAll(o, spec.assert));
  if (mode === 'any') { const ok = results.some(r => !r.length); return { pass: ok, detail: ok ? '' : results[0].join('; ') }; }
  const bad = results.find(r => r.length);
  return { pass: !bad, detail: bad ? bad.join('; ') : '' };
});

Checks.register('podsReady', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  const { objs } = Checks.find(cluster, Object.assign({ kind: 'pod' }, spec));
  const min = spec.minCount !== undefined ? spec.minCount : 1;
  if (objs.length < min) return { pass: false, detail: 'found ' + objs.length + ' matching pod(s), expected at least ' + min };
  const notReady = objs.filter(p => !Sim.isPodReady(cluster, p));
  if (notReady.length) return { pass: false, detail: 'pod ' + notReady[0].metadata.name + ' is ' + Printers.podInfo(cluster, notReady[0]).statusText };
  if (spec.count !== undefined && objs.length !== spec.count) return { pass: false, detail: 'expected ' + spec.count + ' pods, found ' + objs.length };
  return { pass: true };
});

Checks.register('deploymentAvailable', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  const d = cluster.getByKindName('Deployment', spec.namespace, spec.name);
  if (!d) return { pass: false, detail: 'deployment ' + spec.namespace + '/' + spec.name + ' not found' };
  const avail = (d.status && d.status.availableReplicas) || 0;
  const want = spec.replicas !== undefined ? spec.replicas : d.spec.replicas;
  if (spec.replicas !== undefined && d.spec.replicas !== spec.replicas) return { pass: false, detail: 'spec.replicas is ' + d.spec.replicas + ', expected ' + spec.replicas };
  return { pass: avail >= want && want > 0, detail: avail + '/' + want + ' replicas available' };
});

Checks.register('podOnNode', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  const { objs } = Checks.find(cluster, Object.assign({ kind: 'pod' }, spec));
  if (!objs.length) return { pass: false, detail: 'pod not found' };
  for (const p of objs) {
    if (!p.spec.nodeName) return { pass: false, detail: 'pod ' + p.metadata.name + ' is not scheduled (' + (cluster.simState(p).scheduleMessage || 'Pending') + ')' };
    if (spec.node && p.spec.nodeName !== spec.node) return { pass: false, detail: 'pod ' + p.metadata.name + ' is on ' + p.spec.nodeName + ', expected ' + spec.node };
    if (spec.nodeLabel) {
      const node = cluster.node(p.spec.nodeName);
      const ok = Object.entries(spec.nodeLabel).every(([k, v]) => (node.metadata.labels || {})[k] === v);
      if (!ok) return { pass: false, detail: 'pod ' + p.metadata.name + ' is on ' + p.spec.nodeName + ', which lacks label ' + JSON.stringify(spec.nodeLabel) };
    }
    if (spec.ready !== false && !Sim.isPodReady(cluster, p)) return { pass: false, detail: 'pod ' + p.metadata.name + ' is ' + Printers.podInfo(cluster, p).statusText };
  }
  return { pass: true };
});

Checks.register('nodeReady', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  const node = cluster.node(spec.node);
  if (!node) return { pass: false, detail: 'node ' + spec.node + ' not found' };
  const ready = Sim.nodeReady(cluster, node);
  const want = spec.ready !== false;
  return { pass: ready === want, detail: 'node is ' + (ready ? 'Ready' : 'NotReady') };
});
Checks.register('nodeSchedulable', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  const node = cluster.node(spec.node);
  if (!node) return { pass: false, detail: 'node ' + spec.node + ' not found' };
  const sched = !node.spec.unschedulable;
  return { pass: sched === (spec.schedulable !== false), detail: 'node is ' + (sched ? 'schedulable' : 'cordoned') };
});
Checks.register('nodeTaint', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  const node = cluster.node(spec.node);
  if (!node) return { pass: false, detail: 'node ' + spec.node + ' not found' };
  const has = (node.spec.taints || []).some(t => t.key === spec.key && (spec.value === undefined || t.value === spec.value) && (!spec.effect || t.effect === spec.effect));
  return { pass: has === (spec.present !== false), detail: has ? 'taint present' : 'taint ' + spec.key + (spec.value !== undefined ? '=' + spec.value : '') + ':' + (spec.effect || '*') + ' not on node' };
});
Checks.register('nodeLabel', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  const node = cluster.node(spec.node);
  if (!node) return { pass: false, detail: 'node ' + spec.node + ' not found' };
  const bad = Object.entries(spec.labels || {}).filter(([k, v]) => (node.metadata.labels || {})[k] !== v);
  return { pass: !bad.length, detail: bad.length ? 'missing label ' + bad[0][0] + '=' + bad[0][1] : '' };
});
Checks.register('nodeVersion', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  const node = cluster.node(spec.node);
  if (!node) return { pass: false, detail: 'node ' + spec.node + ' not found' };
  const v = node.status.nodeInfo.kubeletVersion.replace(/^v/, '');
  return { pass: v === spec.version, detail: 'kubelet reports v' + v + ', expected v' + spec.version };
});
Checks.register('clusterVersion', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  return { pass: cluster.version === spec.version, detail: 'control plane is v' + cluster.version + ', expected v' + spec.version };
});

Checks.register('serviceEndpoints', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  const svc = cluster.getByKindName('Service', spec.namespace, spec.name);
  if (!svc) return { pass: false, detail: 'service ' + spec.namespace + '/' + spec.name + ' not found' };
  const ep = Printers.endpointsFor(cluster, svc);
  const n = ep.subsets.length ? ep.subsets[0].addresses.length : 0;
  const min = spec.min !== undefined ? spec.min : 1;
  return { pass: n >= min, detail: 'service has ' + n + ' endpoint(s), expected at least ' + min };
});

Checks.register('pvcBound', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  const pvc = cluster.getByKindName('PersistentVolumeClaim', spec.namespace, spec.name);
  if (!pvc) return { pass: false, detail: 'pvc ' + spec.namespace + '/' + spec.name + ' not found' };
  if (pvc.status.phase !== 'Bound') return { pass: false, detail: 'pvc is ' + pvc.status.phase };
  if (spec.volume && pvc.spec.volumeName !== spec.volume) return { pass: false, detail: 'pvc is bound to ' + pvc.spec.volumeName + ', expected ' + spec.volume };
  return { pass: true };
});

Checks.register('canI', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  const m = String(spec.as || '').match(/^system:serviceaccount:([^:]+):(.+)$/);
  const who = m ? { user: spec.as, groups: ['system:serviceaccounts', 'system:authenticated'], sa: m[1] + ':' + m[2] } : { user: spec.as, groups: spec.groups || ['system:authenticated'] };
  const entry = cluster.kinds.resolve(spec.resource);
  const ok = Rbac.canI(cluster, who, spec.verb, entry ? entry.plural : spec.resource, spec.namespace, spec.name);
  const want = spec.expect !== false;
  return { pass: ok === want, detail: spec.as + ' can' + (ok ? '' : 'not') + ' ' + spec.verb + ' ' + spec.resource + (spec.namespace ? ' in ' + spec.namespace : '') + ', expected ' + (want ? 'yes' : 'no') };
});

Checks.register('connectivity', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  const pick = (sel) => { const { objs } = Checks.find(cluster, Object.assign({ kind: 'pod' }, sel)); return objs.find(p => Sim.isPodReady(cluster, p)) || objs[0]; };
  const from = pick(spec.from);
  if (!from) return { pass: false, detail: 'source pod not found (' + JSON.stringify(spec.from) + ')' };
  let to, port = spec.port;
  if (spec.to.service) {
    const svc = cluster.getByKindName('Service', spec.to.namespace || from.metadata.namespace, spec.to.service);
    if (!svc) return { pass: false, detail: 'service ' + spec.to.service + ' not found' };
    const ep = Printers.endpointsFor(cluster, svc);
    if (!ep.subsets.length) return { pass: spec.expect === false, detail: 'service has no endpoints' };
    to = cluster.list(cluster.kinds.resolve('pod'), svc.metadata.namespace).find(p => p.metadata.uid === ep.subsets[0].addresses[0].targetRef.uid);
    port = port || ep.subsets[0].ports[0].port;
  } else {
    to = pick(spec.to);
    if (!to) return { pass: false, detail: 'target pod not found' };
  }
  const v = NetPol.allowed(cluster, from, to, port || 80);
  const want = spec.expect !== false;
  return { pass: v.allowed === want, detail: (v.allowed ? 'traffic allowed' : v.reason) + ', expected ' + (want ? 'allowed' : 'blocked') };
});

Checks.register('hostFile', (world, spec) => {
  const host = Checks.host(world, spec);
  const parts = spec.path.split('/').filter(Boolean);
  const node = host.fs.traverse(parts, null);
  if (!node) return { pass: spec.exists === false, detail: spec.exists === false ? '' : spec.path + ' does not exist on ' + spec.host };
  if (spec.exists === false) return { pass: false, detail: spec.path + ' still exists' };
  if (spec.dir !== undefined && node.isDir !== spec.dir) return { pass: false, detail: spec.path + ' is ' + (node.isDir ? 'a directory' : 'a file') };
  if (node.isDir) return { pass: true };
  const text = node.content;
  if (spec.contains !== undefined && !text.includes(spec.contains)) return { pass: false, detail: spec.path + ' does not contain ' + JSON.stringify(spec.contains) };
  if (spec.notContains !== undefined && text.includes(spec.notContains)) return { pass: false, detail: spec.path + ' still contains ' + JSON.stringify(spec.notContains) };
  if (spec.matches !== undefined && !new RegExp(spec.matches, 'm').test(text)) return { pass: false, detail: spec.path + ' does not match /' + spec.matches + '/' };
  if (spec.equals !== undefined && text.trim() !== String(spec.equals).trim()) return { pass: false, detail: spec.path + ' contains ' + JSON.stringify(text.trim()) + ', expected ' + JSON.stringify(spec.equals) };
  if (spec.minSize !== undefined && text.length < spec.minSize) return { pass: false, detail: spec.path + ' is too small' };
  if (spec.mode !== undefined && node.mode !== parseInt(String(spec.mode), 8)) return { pass: false, detail: spec.path + ' has mode ' + node.mode.toString(8) + ', expected ' + spec.mode };
  return { pass: true };
});
Checks.register('hostService', (world, spec) => {
  const host = Checks.host(world, spec);
  const svc = host.service(spec.name);
  if (!svc) return { pass: false, detail: 'service ' + spec.name + ' not found on ' + spec.host };
  const want = spec.active !== false;
  if (svc.active !== want) return { pass: false, detail: spec.name + ' is ' + (svc.active ? 'active' : 'inactive') + ' on ' + spec.host };
  if (spec.enabled !== undefined && svc.enabled !== spec.enabled) return { pass: false, detail: spec.name + ' is ' + (svc.enabled ? 'enabled' : 'disabled') };
  return { pass: true };
});
Checks.register('hostPackage', (world, spec) => {
  const host = Checks.host(world, spec);
  const v = host.packages[spec.name];
  const ok = v !== undefined && (spec.version === undefined || v === spec.version || v.split('-')[0] === spec.version);
  return { pass: ok, detail: spec.name + ' is ' + (v || 'not installed') + (spec.version ? ', expected ' + spec.version : '') };
});
Checks.register('staticPodHealthy', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  const p = cluster.staticPodProblem(spec.component);
  return { pass: !p, detail: p ? spec.component + ': ' + p : '' };
});
Checks.register('apiHealthy', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  const h = cluster.apiHealthy();
  return { pass: h.ok, detail: h.ok ? '' : h.message };
});
Checks.register('dsCoversNodes', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  const ds = cluster.getByKindName('DaemonSet', spec.namespace, spec.name);
  if (!ds) return { pass: false, detail: 'daemonset ' + spec.namespace + '/' + spec.name + ' not found' };
  const nodes = cluster.nodes().filter(n => spec.includeControlPlane !== false || !('node-role.kubernetes.io/control-plane' in (n.metadata.labels || {})));
  const pods = cluster.list(cluster.kinds.resolve('pod'), spec.namespace).filter(p => ownedBy(p, ds));
  const missing = nodes.filter(n => !pods.some(p => p.spec.nodeName === n.metadata.name));
  if (missing.length) return { pass: false, detail: 'no pod on node(s): ' + missing.map(n => n.metadata.name).join(', ') };
  const notReady = pods.filter(p => !Sim.isPodReady(cluster, p));
  if (notReady.length) return { pass: false, detail: 'pod ' + notReady[0].metadata.name + ' is ' + Printers.podInfo(cluster, notReady[0]).statusText };
  return { pass: true };
});
Checks.register('podLogsContain', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  const { objs } = Checks.find(cluster, Object.assign({ kind: 'pod' }, spec));
  if (!objs.length) return { pass: false, detail: 'pod not found' };
  return { pass: true };
});

Checks.register('nodeEmpty', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  const node = cluster.node(spec.node);
  if (!node) return { pass: false, detail: 'node ' + spec.node + ' not found' };
  const pods = cluster.list(cluster.kinds.resolve('pod'), null).filter(p => p.spec.nodeName === spec.node)
    .filter(p => !(spec.ignoreDaemonSets !== false && (p.metadata.ownerReferences || []).some(r => r.kind === 'DaemonSet' || r.kind === 'Node')));
  return { pass: !pods.length, detail: pods.length ? pods.length + ' workload pod(s) still on ' + spec.node + ' (e.g. ' + pods[0].metadata.namespace + '/' + pods[0].metadata.name + ')' : '' };
});

Checks.register('hostApparmorLoaded', (world, spec) => {
  const host = Checks.host(world, spec);
  const ok = host.apparmor.has(spec.profile);
  return { pass: ok, detail: ok ? '' : 'AppArmor profile ' + spec.profile + ' is not loaded on ' + spec.host };
});

Checks.register('hostSysctl', (world, spec) => {
  const host = Checks.host(world, spec);
  const v = host.sysctl[spec.key];
  return { pass: v !== undefined && String(v) === String(spec.value), detail: spec.key + ' is ' + (v === undefined ? 'unset' : v) + ' on ' + spec.host + ', expected ' + spec.value };
});

/* Helm release state kept by commands/helm.js: { namespace, name, chart, version, revision, minRevision, status, values: {path: expectation} } */
Checks.register('helmRelease', (world, spec) => {
  const cluster = Checks.cluster(world, spec);
  const ns = spec.namespace || 'default';
  const rel = cluster.helm && cluster.helm.releases.get(ns + '/' + spec.name);
  if (!rel) return { pass: spec.exists === false, detail: spec.exists === false ? '' : 'helm release ' + spec.name + ' not found in namespace ' + ns };
  if (spec.exists === false) return { pass: false, detail: 'helm release ' + spec.name + ' still exists in namespace ' + ns };
  if (spec.chart && rel.chart !== spec.chart) return { pass: false, detail: 'release ' + spec.name + ' uses chart ' + rel.chart + ', expected ' + spec.chart };
  if (spec.version && rel.chartVersion !== spec.version) return { pass: false, detail: 'release ' + spec.name + ' is at chart version ' + rel.chartVersion + ', expected ' + spec.version };
  if (spec.revision !== undefined && rel.revision !== spec.revision) return { pass: false, detail: 'release ' + spec.name + ' is at revision ' + rel.revision + ', expected ' + spec.revision };
  if (spec.minRevision !== undefined && rel.revision < spec.minRevision) return { pass: false, detail: 'release ' + spec.name + ' is at revision ' + rel.revision + ', expected at least ' + spec.minRevision };
  if (spec.status && rel.status !== spec.status) return { pass: false, detail: 'release ' + spec.name + ' is ' + rel.status + ', expected ' + spec.status };
  if (spec.values) { const failed = Checks.assertAll(rel.merged || {}, spec.values); if (failed.length) return { pass: false, detail: 'values: ' + failed.join('; ') }; }
  return { pass: true };
});
