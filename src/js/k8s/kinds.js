/* k8s/kinds.js — the API resource registry. Resolves the many names
   kubectl accepts (pod, pods, po, deployment.apps, ...) to a kind entry,
   and can be extended at runtime when a CRD is created. */

const BUILTIN_KINDS = [
  { kind: 'Pod', plural: 'pods', short: ['po'], group: '', version: 'v1', namespaced: true },
  { kind: 'Service', plural: 'services', short: ['svc'], group: '', version: 'v1', namespaced: true },
  { kind: 'Namespace', plural: 'namespaces', short: ['ns'], group: '', version: 'v1', namespaced: false },
  { kind: 'Node', plural: 'nodes', short: ['no'], group: '', version: 'v1', namespaced: false },
  { kind: 'ConfigMap', plural: 'configmaps', short: ['cm'], group: '', version: 'v1', namespaced: true },
  { kind: 'Secret', plural: 'secrets', short: [], group: '', version: 'v1', namespaced: true },
  { kind: 'ServiceAccount', plural: 'serviceaccounts', short: ['sa'], group: '', version: 'v1', namespaced: true },
  { kind: 'PersistentVolume', plural: 'persistentvolumes', short: ['pv'], group: '', version: 'v1', namespaced: false },
  { kind: 'PersistentVolumeClaim', plural: 'persistentvolumeclaims', short: ['pvc'], group: '', version: 'v1', namespaced: true },
  { kind: 'Endpoints', plural: 'endpoints', short: ['ep'], group: '', version: 'v1', namespaced: true, virtual: true },
  { kind: 'Event', plural: 'events', short: ['ev'], group: '', version: 'v1', namespaced: true, virtual: true },
  { kind: 'ResourceQuota', plural: 'resourcequotas', short: ['quota'], group: '', version: 'v1', namespaced: true },
  { kind: 'LimitRange', plural: 'limitranges', short: ['limits'], group: '', version: 'v1', namespaced: true },
  { kind: 'Deployment', plural: 'deployments', short: ['deploy'], group: 'apps', version: 'v1', namespaced: true },
  { kind: 'ReplicaSet', plural: 'replicasets', short: ['rs'], group: 'apps', version: 'v1', namespaced: true },
  { kind: 'DaemonSet', plural: 'daemonsets', short: ['ds'], group: 'apps', version: 'v1', namespaced: true },
  { kind: 'StatefulSet', plural: 'statefulsets', short: ['sts'], group: 'apps', version: 'v1', namespaced: true },
  { kind: 'Job', plural: 'jobs', short: [], group: 'batch', version: 'v1', namespaced: true },
  { kind: 'CronJob', plural: 'cronjobs', short: ['cj'], group: 'batch', version: 'v1', namespaced: true },
  { kind: 'Ingress', plural: 'ingresses', short: ['ing'], group: 'networking.k8s.io', version: 'v1', namespaced: true },
  { kind: 'IngressClass', plural: 'ingressclasses', short: [], group: 'networking.k8s.io', version: 'v1', namespaced: false },
  { kind: 'NetworkPolicy', plural: 'networkpolicies', short: ['netpol'], group: 'networking.k8s.io', version: 'v1', namespaced: true },
  { kind: 'Role', plural: 'roles', short: [], group: 'rbac.authorization.k8s.io', version: 'v1', namespaced: true },
  { kind: 'RoleBinding', plural: 'rolebindings', short: [], group: 'rbac.authorization.k8s.io', version: 'v1', namespaced: true },
  { kind: 'ClusterRole', plural: 'clusterroles', short: [], group: 'rbac.authorization.k8s.io', version: 'v1', namespaced: false },
  { kind: 'ClusterRoleBinding', plural: 'clusterrolebindings', short: [], group: 'rbac.authorization.k8s.io', version: 'v1', namespaced: false },
  { kind: 'StorageClass', plural: 'storageclasses', short: ['sc'], group: 'storage.k8s.io', version: 'v1', namespaced: false },
  { kind: 'HorizontalPodAutoscaler', plural: 'horizontalpodautoscalers', short: ['hpa'], group: 'autoscaling', version: 'v2', namespaced: true },
  { kind: 'RuntimeClass', plural: 'runtimeclasses', short: [], group: 'node.k8s.io', version: 'v1', namespaced: false },
  { kind: 'PriorityClass', plural: 'priorityclasses', short: ['pc'], group: 'scheduling.k8s.io', version: 'v1', namespaced: false },
  { kind: 'PodDisruptionBudget', plural: 'poddisruptionbudgets', short: ['pdb'], group: 'policy', version: 'v1', namespaced: true },
  { kind: 'CustomResourceDefinition', plural: 'customresourcedefinitions', short: ['crd', 'crds'], group: 'apiextensions.k8s.io', version: 'v1', namespaced: false },
  { kind: 'GatewayClass', plural: 'gatewayclasses', short: ['gc'], group: 'gateway.networking.k8s.io', version: 'v1', namespaced: false },
  { kind: 'Gateway', plural: 'gateways', short: ['gtw'], group: 'gateway.networking.k8s.io', version: 'v1', namespaced: true },
  { kind: 'HTTPRoute', plural: 'httproutes', short: [], group: 'gateway.networking.k8s.io', version: 'v1', namespaced: true },
];

class KindRegistry {
  constructor() {
    this.kinds = [];
    for (const k of BUILTIN_KINDS) this.add(k);
  }

  add(k) {
    const entry = Object.assign({ short: [], singular: k.kind.toLowerCase() }, k);
    entry.apiVersion = entry.group ? entry.group + '/' + entry.version : entry.version;
    this.kinds = this.kinds.filter(x => !(x.kind === entry.kind && x.group === entry.group));
    this.kinds.push(entry);
    return entry;
  }

  /* Accepts: kind (any case), plural, singular, short name, and any of
     those with '.group' appended (deployment.apps, deployments.apps). */
  resolve(name) {
    if (!name) return null;
    let n = String(name).toLowerCase();
    let group = null;
    const firstDot = n.indexOf('.');
    if (firstDot !== -1) { group = n.slice(firstDot + 1); n = n.slice(0, firstDot); }
    const matches = this.kinds.filter(k =>
      k.kind.toLowerCase() === n || k.plural === n || k.singular === n || k.short.includes(n));
    if (!matches.length) return null;
    if (group !== null) {
      const g = matches.find(k => k.group === group || k.group.startsWith(group + '.') || (group === 'v1' && k.group === ''));
      return g || null;
    }
    return matches[0];
  }

  byKind(kind, apiVersion) {
    const cands = this.kinds.filter(k => k.kind === kind);
    if (cands.length <= 1 || !apiVersion) return cands[0] || null;
    const group = apiVersion.includes('/') ? apiVersion.split('/')[0] : '';
    return cands.find(k => k.group === group) || cands[0];
  }

  /* kubectl's "deployment.apps/name" style. */
  fullName(entry, name) {
    return entry.singular + (entry.group ? '.' + entry.group : '') + '/' + name;
  }

  list() { return this.kinds.slice().sort((a, b) => (a.group + a.plural).localeCompare(b.group + b.plural)); }
}
