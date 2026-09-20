/* k8s/kubectl.js — the kubectl command. Speaks the real dialect: resource
   name forms, -n/-A/-l/-o, --dry-run=client -o yaml, create subcommands,
   run/expose/scale/set/rollout/label/taint/cordon/drain/logs/exec/top/
   config/edit/auth/patch/wait. Errors print exactly as kubectl would. */

class KubectlError extends ShellError {}
class RawError extends ShellError {}   // printed verbatim (connection refused etc.)

const KC_BOOL = new Set(['all-namespaces', 'show-labels', 'no-headers', 'watch', 'force', 'ignore-daemonsets', 'delete-emptydir-data',
  'delete-local-data', 'overwrite', 'rm', 'stdin', 'tty', 'previous', 'all', 'record', 'command', 'recursive', 'now', 'wait', 'list',
  'help', 'follow', 'timestamps', 'disable-eviction', 'allow-missing-template-keys', 'show-managed-fields', 'ignore-not-found',
  'current', 'flatten', 'minify', 'raw', 'short', 'client', 'namespaced', 'global-default', 'expose', 'quiet', 'all-containers',
  'save-config', 'prune', 'cascade', 'wait', 'validate', 'server-side', 'show-kind', 'show-events', 'insecure-skip-tls-verify',
  'leave-stdin-open', 'restart-policy', 'attach', 'delete-emptydir-data', 'show-events', 'sort-by-none', 'reverse', 'containers']);
const KC_MULTI = new Set(['from-literal', 'from-file', 'from-env-file', 'env', 'verb', 'resource', 'serviceaccount', 'user', 'group',
  'tcp', 'filename', 'rule', 'resource-name', 'as-group', 'labels-multi']);
const KC_SHORT = { n: 'namespace', o: 'output', l: 'selector', f: 'filename', c: 'container', A: 'all-namespaces', p: 'previous',
  w: 'watch', R: 'recursive', i: 'stdin', t: 'tty', h: 'help', k: 'kustomize', L: 'label-columns', v: 'v' };
const KC_SHORT_VALUE = new Set(['n', 'o', 'l', 'f', 'c', 'L', 'k', 'v']);

function kcParse(args, { boolShort = [] } = {}) {
  const flags = {}, positional = [];
  let rest = null;
  const set = (name, val) => {
    if (KC_MULTI.has(name)) (flags[name] = flags[name] || []).push(val);
    else flags[name] = val;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { rest = args.slice(i + 1); break; }
    if (a.startsWith('--')) {
      let name = a.slice(2), val;
      const eq = name.indexOf('=');
      if (eq !== -1) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      if (name === 'dry-run') { set(name, val === undefined ? 'client' : val); continue; }
      if (KC_BOOL.has(name) || (name === 'follow')) { set(name, val === undefined ? true : val !== 'false'); continue; }
      if (val === undefined) { if (i + 1 >= args.length) throw new KubectlError('flag needs an argument: --' + name); val = args[++i]; }
      set(name, val);
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      const letters = a.slice(1);
      for (let j = 0; j < letters.length; j++) {
        const ch = letters[j];
        const name = KC_SHORT[ch];
        if (boolShort.includes(ch)) { set(ch === 'f' ? 'follow' : name || ch, true); continue; }
        if (KC_SHORT_VALUE.has(ch)) {
          let val = letters.slice(j + 1);
          if (val.startsWith('=')) val = val.slice(1);
          if (!val) { if (i + 1 >= args.length) throw new KubectlError('flag needs an argument: \'' + ch + '\' in -' + ch); val = args[++i]; }
          set(name, val);
          break;
        }
        if (name) { set(name, true); continue; }
        throw new KubectlError('unknown shorthand flag: \'' + ch + '\' in -' + letters);
      }
      continue;
    }
    positional.push(a);
  }
  return { flags, positional, rest };
}

const EXPLAIN_DOCS = {
  'pod': 'KIND:       Pod\nVERSION:    v1\n\nDESCRIPTION:\n    Pod is a collection of containers that can run on a host.\n\nFIELDS:\n  apiVersion\t<string>\n  kind\t<string>\n  metadata\t<ObjectMeta>\n  spec\t<PodSpec>\n  status\t<PodStatus>',
  'pod.spec': 'FIELD: spec <PodSpec>\n\nDESCRIPTION:\n    Specification of the desired behavior of the pod.\n\nFIELDS:\n  activeDeadlineSeconds\t<integer>\n  affinity\t<Affinity>\n  containers\t<[]Container> -required-\n  dnsPolicy\t<string>\n  hostNetwork\t<boolean>\n  initContainers\t<[]Container>\n  nodeName\t<string>\n  nodeSelector\t<map[string]string>\n  priorityClassName\t<string>\n  restartPolicy\t<string>\n  schedulerName\t<string>\n  securityContext\t<PodSecurityContext>\n  serviceAccountName\t<string>\n  tolerations\t<[]Toleration>\n  volumes\t<[]Volume>',
  'pod.spec.containers': 'FIELD: containers <[]Container>\n\nDESCRIPTION:\n    List of containers belonging to the pod. Containers cannot currently be added or removed. There must be at least one container in a Pod.\n\nFIELDS:\n  args\t<[]string>\n  command\t<[]string>\n  env\t<[]EnvVar>\n  envFrom\t<[]EnvFromSource>\n  image\t<string>\n  imagePullPolicy\t<string>\n  livenessProbe\t<Probe>\n  name\t<string> -required-\n  ports\t<[]ContainerPort>\n  readinessProbe\t<Probe>\n  resources\t<ResourceRequirements>\n  securityContext\t<SecurityContext>\n  volumeMounts\t<[]VolumeMount>',
  'pod.spec.tolerations': 'FIELD: tolerations <[]Toleration>\n\nDESCRIPTION:\n    If specified, the pod\'s tolerations.\n\nFIELDS:\n  effect\t<string>\n  key\t<string>\n  operator\t<string>\n  tolerationSeconds\t<integer>\n  value\t<string>',
  'pod.spec.volumes': 'FIELD: volumes <[]Volume>\n\nDESCRIPTION:\n    List of volumes that can be mounted by containers belonging to the pod.\n\nFIELDS:\n  configMap\t<ConfigMapVolumeSource>\n  emptyDir\t<EmptyDirVolumeSource>\n  hostPath\t<HostPathVolumeSource>\n  name\t<string> -required-\n  persistentVolumeClaim\t<PersistentVolumeClaimVolumeSource>\n  secret\t<SecretVolumeSource>',
  'deployment': 'KIND:       Deployment\nVERSION:    apps/v1\n\nDESCRIPTION:\n    Deployment enables declarative updates for Pods and ReplicaSets.\n\nFIELDS:\n  apiVersion\t<string>\n  kind\t<string>\n  metadata\t<ObjectMeta>\n  spec\t<DeploymentSpec>\n  status\t<DeploymentStatus>',
  'deployment.spec': 'FIELD: spec <DeploymentSpec>\n\nFIELDS:\n  minReadySeconds\t<integer>\n  paused\t<boolean>\n  progressDeadlineSeconds\t<integer>\n  replicas\t<integer>\n  revisionHistoryLimit\t<integer>\n  selector\t<LabelSelector> -required-\n  strategy\t<DeploymentStrategy>\n  template\t<PodTemplateSpec> -required-',
  'deployment.spec.strategy': 'FIELD: strategy <DeploymentStrategy>\n\nFIELDS:\n  rollingUpdate\t<RollingUpdateDeployment>\n  type\t<string>\n    Type of deployment. Can be "Recreate" or "RollingUpdate". Default is RollingUpdate.',
  'service': 'KIND:       Service\nVERSION:    v1\n\nDESCRIPTION:\n    Service is a named abstraction of software service consisting of a proxy port and a selector.\n\nFIELDS:\n  apiVersion\t<string>\n  kind\t<string>\n  metadata\t<ObjectMeta>\n  spec\t<ServiceSpec>\n  status\t<ServiceStatus>',
  'service.spec': 'FIELD: spec <ServiceSpec>\n\nFIELDS:\n  clusterIP\t<string>\n  externalName\t<string>\n  ports\t<[]ServicePort>\n  selector\t<map[string]string>\n  sessionAffinity\t<string>\n  type\t<string>\n    type determines how the Service is exposed. Valid options are ClusterIP, NodePort, LoadBalancer, and ExternalName.',
  'networkpolicy.spec': 'FIELD: spec <NetworkPolicySpec>\n\nFIELDS:\n  egress\t<[]NetworkPolicyEgressRule>\n  ingress\t<[]NetworkPolicyIngressRule>\n  podSelector\t<LabelSelector> -required-\n  policyTypes\t<[]string>',
  'networkpolicy.spec.ingress': 'FIELD: ingress <[]NetworkPolicyIngressRule>\n\nFIELDS:\n  from\t<[]NetworkPolicyPeer>\n    ipBlock, namespaceSelector, podSelector\n  ports\t<[]NetworkPolicyPort>',
  'persistentvolume.spec': 'FIELD: spec <PersistentVolumeSpec>\n\nFIELDS:\n  accessModes\t<[]string>\n  capacity\t<map[string]Quantity>\n  hostPath\t<HostPathVolumeSource>\n  local\t<LocalVolumeSource>\n  nfs\t<NFSVolumeSource>\n  nodeAffinity\t<VolumeNodeAffinity>\n  persistentVolumeReclaimPolicy\t<string>\n  storageClassName\t<string>',
  'persistentvolumeclaim.spec': 'FIELD: spec <PersistentVolumeClaimSpec>\n\nFIELDS:\n  accessModes\t<[]string>\n  resources\t<VolumeResourceRequirements>\n  storageClassName\t<string>\n  volumeMode\t<string>\n  volumeName\t<string>',
  'ingress.spec': 'FIELD: spec <IngressSpec>\n\nFIELDS:\n  defaultBackend\t<IngressBackend>\n  ingressClassName\t<string>\n  rules\t<[]IngressRule>\n  tls\t<[]IngressTLS>',
  'ingress.spec.rules': 'FIELD: rules <[]IngressRule>\n\nFIELDS:\n  host\t<string>\n  http\t<HTTPIngressRuleValue>\n    paths <[]HTTPIngressPath>: backend (service.name, service.port.number), path, pathType (Exact | Prefix | ImplementationSpecific)',
  'cronjob.spec': 'FIELD: spec <CronJobSpec>\n\nFIELDS:\n  concurrencyPolicy\t<string>\n  failedJobsHistoryLimit\t<integer>\n  jobTemplate\t<JobTemplateSpec> -required-\n  schedule\t<string> -required-\n  startingDeadlineSeconds\t<integer>\n  successfulJobsHistoryLimit\t<integer>\n  suspend\t<boolean>\n  timeZone\t<string>',
  'job.spec': 'FIELD: spec <JobSpec>\n\nFIELDS:\n  activeDeadlineSeconds\t<integer>\n  backoffLimit\t<integer>\n  completions\t<integer>\n  parallelism\t<integer>\n  template\t<PodTemplateSpec> -required-\n  ttlSecondsAfterFinished\t<integer>',
  'horizontalpodautoscaler.spec': 'FIELD: spec <HorizontalPodAutoscalerSpec>\n\nFIELDS:\n  behavior\t<HorizontalPodAutoscalerBehavior>\n  maxReplicas\t<integer> -required-\n  metrics\t<[]MetricSpec>\n  minReplicas\t<integer>\n  scaleTargetRef\t<CrossVersionObjectReference> -required-',
};

class Kubectl {
  constructor(app) { this.app = app; }

  async run(ctx, args, io) {
    try {
      await this.dispatch(ctx, args, io);
    } catch (e) {
      if (e instanceof ApiError) io.err(e.toString());
      else if (e instanceof RawError) io.err(e.message);
      else if (e instanceof KubectlError) io.err('error: ' + e.message);
      else if (e instanceof YAML.YamlError) io.err('error: error parsing YAML: ' + e.message);
      else if (e instanceof ShellError) io.err('error: ' + e.message);
      else throw e;
    }
  }

  fullName(cluster, obj) {
    const entry = cluster.kinds.byKind(obj.kind, obj.apiVersion);
    return entry ? cluster.kinds.fullName(entry, obj.metadata.name) : obj.kind.toLowerCase() + '/' + obj.metadata.name;
  }

  /* Which cluster/namespace/user is kubectl talking to from this host? */
  target(ctx, flags, { needApi = true } = {}) {
    const host = ctx.session.host;
    let kc = host.kubeconfig;
    if (flags.kubeconfig) {
      const parts = ctx.session.resolvePath(flags.kubeconfig);
      if (!host.fs.exists(parts, null)) throw new RawError('error: stat ' + flags.kubeconfig + ': no such file or directory');
      kc = host.kubeconfig || host.adminKubeconfig || null;
    }
    if (!kc) throw new RawError('The connection to the server localhost:8080 was refused - did you specify the right host or port?');
    const ctxName = flags.context || kc.current;
    const c = kc.contexts[ctxName];
    if (!c) throw new KubectlError('context "' + ctxName + '" does not exist');
    const cluster = this.app.world.clusters.get(c.cluster);
    if (!cluster) throw new KubectlError('cluster "' + c.cluster + '" does not exist');
    if (needApi) {
      const h = cluster.apiHealthy();
      if (!h.ok) throw new RawError(h.message);
      Sim.reconcile(cluster);
    }
    const ns = flags.namespace || c.namespace || 'default';
    return { cluster, ns, allNs: !!flags['all-namespaces'], ctxName, kc, who: { user: c.user || 'kubernetes-admin', groups: ['system:masters', 'system:authenticated'] } };
  }

  readFiles(ctx, flags) {
    const files = flags.filename || [];
    if (!files.length) throw new KubectlError('must specify one of -f and -k');
    const docs = [];
    const s = ctx.session;
    const readOne = (p) => {
      const parts = s.resolvePath(p);
      let node;
      try { node = s.fs.node(parts, s.user); } catch (e) { throw new KubectlError('the path "' + p + '" does not exist'); }
      if (node.isDir) {
        for (const n of node.names()) if (/\.(ya?ml|json)$/.test(n)) readOne(p.replace(/\/$/, '') + '/' + n);
        return;
      }
      const text = s.fs.readFile(parts, s.user);
      const trimmed = text.trim();
      const parsed = trimmed.startsWith('{') ? [JSON.parse(trimmed)] : YAML.parseAll(text);
      for (const d of parsed) {
        if (d === null) continue;
        if (d && d.kind === 'List' && Array.isArray(d.items)) docs.push(...d.items);
        else docs.push(d);
      }
    };
    for (const f of files) readOne(f);
    if (!docs.length) throw new KubectlError('no objects passed to ' + (flags._verb || 'apply'));
    return docs;
  }

  parseResources(cluster, positional, { allowNone = false } = {}) {
    if (!positional.length) {
      if (allowNone) return [];
      throw new KubectlError('You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.');
    }
    const resolve = (k) => {
      if (k === 'all') return null;
      const e = cluster.kinds.resolve(k);
      if (!e) throw new KubectlError('the server doesn\'t have a resource type "' + k + '"');
      return e;
    };
    const groups = [];
    if (positional[0].includes('/')) {
      for (const p of positional) {
        const [k, ...n] = p.split('/');
        const name = n.join('/');
        if (!name) throw new KubectlError('arguments in resource/name form must have a single resource and name');
        const e = resolve(k);
        let g = groups.find(x => x.entry === e);
        if (!g) { g = { entry: e, names: [] }; groups.push(g); }
        g.names.push(name);
      }
      return groups;
    }
    const kinds = positional[0].split(',');
    const names = positional.slice(1);
    for (const k of kinds) {
      if (k === 'all') {
        for (const a of ['pods', 'services', 'daemonsets', 'deployments', 'replicasets', 'statefulsets', 'horizontalpodautoscalers', 'jobs', 'cronjobs']) groups.push({ entry: cluster.kinds.resolve(a), names: names.slice(), all: true });
      } else groups.push({ entry: resolve(k), names: names.slice() });
    }
    return groups;
  }

  listObjs(t, entry, { selector, fieldSelector, names } = {}) {
    const cluster = t.cluster;
    let objs;
    if (entry.kind === 'Endpoints') {
      objs = cluster.list(cluster.kinds.resolve('svc'), t.allNs ? null : t.ns).map(s => Printers.endpointsFor(cluster, s));
    } else if (entry.kind === 'Event') {
      objs = cluster.events.filter(e => t.allNs || e.involvedObject.namespace === t.ns || (!e.involvedObject.namespace && t.ns === 'default')).map(Printers.eventObject);
    } else {
      objs = cluster.list(entry, t.allNs || !entry.namespaced ? null : t.ns);
    }
    if (names && names.length) {
      objs = names.map(n => {
        const o = objs.find(x => x.metadata.name === n);
        if (!o) throw new ApiError('NotFound', entry.plural + ' "' + n + '" not found');
        return o;
      });
    }
    if (selector) objs = objs.filter(o => labelsMatch(selector, o.metadata.labels));
    if (fieldSelector) {
      for (const raw of fieldSelector.split(',')) {
        const m = raw.match(/^([^!=]+)(!=|==|=)(.*)$/);
        if (!m) continue;
        objs = objs.filter(o => { const v = String(getPath(o, m[1])); return m[2] === '!=' ? v !== m[3] : v === m[3]; });
      }
    }
    return objs;
  }

  sortObjs(objs, sortBy) {
    const path = sortBy.replace(/^\{|\}$/g, '');
    return objs.slice().sort((a, b) => {
      const va = Printers.jpEval(path, a)[0], vb = Printers.jpEval(path, b)[0];
      if (typeof va === 'number' && typeof vb === 'number') return va - vb;
      return String(va === undefined ? '' : va).localeCompare(String(vb === undefined ? '' : vb), undefined, { numeric: true });
    });
  }

  /* Client-side object as kubectl prints it with --dry-run=client -o yaml. */
  clientObject(obj) {
    const c = deepClone(obj);
    c.metadata = Object.assign({ creationTimestamp: null }, c.metadata);
    if (c.status === undefined && !['ConfigMap', 'Secret', 'ServiceAccount', 'Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding', 'StorageClass', 'PriorityClass'].includes(c.kind)) c.status = {};
    return c;
  }

  emit(io, obj, flags, verb) {
    const o = flags.output;
    if (o === 'yaml') io.out(Printers.toYaml(obj));
    else if (o === 'json') io.out(Printers.toJson(obj));
    else if (o === 'name') io.out(this.fullName(this._cluster, obj));
    else io.out(this.fullName(this._cluster, obj) + ' ' + verb + (flags['dry-run'] ? ' (dry run)' : ''));
  }

  async dispatch(ctx, args, io) {
    if (!args.length || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
      io.out('kubectl controls the Kubernetes cluster manager.\n\nBasic Commands:\n  create, expose, run, set, explain, get, edit, delete\nDeploy Commands:\n  rollout, scale, autoscale\nCluster Management Commands:\n  cluster-info, top, cordon, uncordon, drain, taint\nTroubleshooting and Debugging Commands:\n  describe, logs, exec, events\nAdvanced Commands:\n  apply, patch, replace, wait\nSettings Commands:\n  label, annotate\nOther Commands:\n  api-resources, api-versions, config, version, auth\n\nUse "kubectl <command> --help" for more information about a given command.');
      return;
    }
    // global flags may precede the verb: kubectl -n shop get pods
    const lead = [];
    let idx = 0;
    while (idx < args.length && args[idx].startsWith('-')) {
      const a = args[idx];
      lead.push(a);
      if (!a.includes('=') && /^(-n|--namespace|--context|--kubeconfig|-s|--server|-v|--as|--as-group|--cluster|--user)$/.test(a) && idx + 1 < args.length) lead.push(args[++idx]);
      idx++;
    }
    const verb = args[idx];
    if (!verb) throw new KubectlError('you must specify a command');
    let rest = lead.concat(args.slice(idx + 1));
    if (verb === 'patch') rest = rest.map(a => a === '-p' ? '--patch' : a.startsWith('-p=') ? '--patch=' + a.slice(3) : a);
    const boolShort = verb === 'logs' ? ['f', 'p'] : verb === 'exec' || verb === 'run' ? ['i', 't'] : [];
    const parsed = kcParse(rest, { boolShort });
    parsed.flags._verb = verb;
    if (parsed.flags.help) { io.out('See https://kubernetes.io/docs/reference/kubectl/ for kubectl ' + verb + ' usage.'); return; }
    const method = 'cmd_' + verb.replace(/-/g, '_');
    if (typeof this[method] !== 'function') {
      if (['cp', 'port-forward', 'attach', 'proxy', 'debug', 'certificate', 'plugin', 'kustomize', 'diff'].includes(verb)) throw new KubectlError('"' + verb + '" is not supported in this simulator');
      throw new KubectlError('unknown command "' + verb + '" for "kubectl"\n\nDid you mean this?\n\tget\n\tdescribe');
    }
    await this[method](ctx, parsed, io);
  }

  /* ---------- get / describe ---------- */
  cmd_get(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags);
    this._cluster = t.cluster;
    const groups = this.parseResources(t.cluster, positional);
    const selector = flags.selector ? parseLabelSelector(flags.selector) : null;
    const results = [];
    for (const g of groups) {
      let objs = this.listObjs(t, g.entry, { selector, fieldSelector: flags['field-selector'], names: g.names });
      if (flags['sort-by']) objs = this.sortObjs(objs, flags['sort-by']);
      results.push({ entry: g.entry, objs, named: g.names.length });
    }
    const all = results.flatMap(r => r.objs);
    const single = results.length === 1 && results[0].named === 1;
    const o = flags.output || '';
    if (o === 'yaml' || o === 'json') {
      const data = single ? all[0] : Printers.listOf(all);
      io.out(o === 'yaml' ? Printers.toYaml(data) : Printers.toJson(data));
      return;
    }
    if (o === 'name') { for (const r of results) for (const x of r.objs) io.out(t.cluster.kinds.fullName(r.entry, x.metadata.name)); return; }
    if (o.startsWith('jsonpath=') || o.startsWith('jsonpath-as-json=')) {
      const expr = o.slice(o.indexOf('=') + 1);
      const data = single ? all[0] : Printers.listOf(all);
      const text = Printers.jsonpath(expr, data);
      if (text.length) io.out(text.replace(/\n$/, ''));
      return;
    }
    if (o.startsWith('custom-columns=')) {
      const { headers, rows } = Printers.customColumns(o.slice(15), all);
      io.out(Printers.table(headers, rows, { noHeaders: !!flags['no-headers'] }));
      return;
    }
    if (o && o !== 'wide') throw new KubectlError('unable to match a printer suitable for the output format "' + o + '", allowed formats are: custom-columns,custom-columns-file,go-template,go-template-file,json,jsonpath,jsonpath-as-json,jsonpath-file,name,template,templatefile,wide,yaml');
    const blocks = [];
    for (const r of results) {
      if (!r.objs.length) {
        if (results.length === 1) io.out((t.allNs || !r.entry.namespaced) ? 'No resources found' : 'No resources found in ' + t.ns + ' namespace.');
        continue;
      }
      blocks.push(Printers.getTable(t.cluster, r.entry, r.objs, { wide: o === 'wide', showLabels: !!flags['show-labels'], allNamespaces: t.allNs && r.entry.namespaced, noHeaders: !!flags['no-headers'], prefixKind: results.length > 1 }));
    }
    if (blocks.length) io.out(blocks.join('\n\n'));
    else if (results.length > 1) io.out(t.allNs ? 'No resources found' : 'No resources found in ' + t.ns + ' namespace.');
  }

  cmd_describe(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags);
    const groups = this.parseResources(t.cluster, positional);
    const selector = flags.selector ? parseLabelSelector(flags.selector) : null;
    const out = [];
    for (const g of groups) {
      const objs = this.listObjs(t, g.entry, { selector, names: g.names });
      for (const o of objs) out.push(Printers.describe(t.cluster, g.entry, o));
    }
    if (!out.length) return io.out(t.allNs ? 'No resources found' : 'No resources found in ' + t.ns + ' namespace.');
    io.out(out.join('\n\n\n'));
  }

  cmd_events(ctx, parsed, io) { parsed.positional = ['events']; return this.cmd_get(ctx, parsed, io); }

  /* ---------- create ---------- */
  async cmd_create(ctx, { flags, positional, rest }, io) {
    const t = this.target(ctx, flags);
    this._cluster = t.cluster;
    if (flags.filename) {
      for (const doc of this.readFiles(ctx, flags)) this.createObject(t, doc, flags, io, 'created');
      return;
    }
    const sub = positional[0];
    if (!sub) throw new KubectlError('must specify one of -f and -k');
    const name = positional[1];
    const need = (v, msg) => { if (!v) throw new KubectlError(msg); };
    const ns = t.ns;
    const labelsFromFlag = () => Object.fromEntries((flags.labels || '').split(',').filter(Boolean).map(kv => kv.split('=')));
    let obj;
    switch (sub) {
      case 'namespace': case 'ns':
        need(name, 'exactly one NAME is required, got 0');
        obj = { apiVersion: 'v1', kind: 'Namespace', metadata: { name, labels: { 'kubernetes.io/metadata.name': name } }, spec: {} };
        break;
      case 'deployment': case 'deploy': {
        need(name, 'NAME is required');
        need(flags.image, 'required flag(s) "image" not set');
        const images = flags.image.split(',');
        const containers = images.map(img => { const c = { name: this.containerName(img), image: img, resources: {} }; if (flags.port) c.ports = [{ containerPort: parseInt(flags.port, 10) }]; return c; });
        if (rest && rest.length && containers.length === 1) containers[0].command = rest;
        obj = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels: { app: name } },
          spec: { replicas: parseInt(flags.replicas || '1', 10), selector: { matchLabels: { app: name } }, strategy: {}, template: { metadata: { labels: { app: name } }, spec: { containers } } } };
        break;
      }
      case 'service': case 'svc': {
        const type = positional[1]; const sname = positional[2];
        need(sname, 'NAME is required');
        const typeMap = { clusterip: 'ClusterIP', nodeport: 'NodePort', loadbalancer: 'LoadBalancer', externalname: 'ExternalName' };
        need(typeMap[type], 'unknown service type: ' + type);
        const ports = (flags.tcp || []).map(p => { const [port, tp] = p.split(':'); return { name: port + '-' + (tp || port), port: parseInt(port, 10), protocol: 'TCP', targetPort: parseInt(tp || port, 10) }; });
        obj = { apiVersion: 'v1', kind: 'Service', metadata: { name: sname, namespace: ns, labels: { app: sname } }, spec: { type: typeMap[type], selector: { app: sname }, ports } };
        if (type === 'clusterip' && flags.clusterip) obj.spec.clusterIP = flags.clusterip;
        if (type === 'externalname') { obj.spec.externalName = flags['external-name']; delete obj.spec.selector; }
        break;
      }
      case 'configmap': case 'cm': {
        need(name, 'NAME is required');
        obj = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: ns }, data: this.kvData(ctx, flags) };
        break;
      }
      case 'secret': {
        const stype = positional[1]; const sname = positional[2];
        need(sname, 'NAME is required');
        if (stype === 'generic') {
          obj = { apiVersion: 'v1', kind: 'Secret', metadata: { name: sname, namespace: ns }, type: flags.type || 'Opaque', data: Object.fromEntries(Object.entries(this.kvData(ctx, flags)).map(([k, v]) => [k, btoa(unescape(encodeURIComponent(v)))])) };
        } else if (stype === 'docker-registry') {
          const auth = { auths: { [flags['docker-server'] || 'https://index.docker.io/v1/']: { username: flags['docker-username'], password: flags['docker-password'], email: flags['docker-email'], auth: btoa((flags['docker-username'] || '') + ':' + (flags['docker-password'] || '')) } } };
          obj = { apiVersion: 'v1', kind: 'Secret', metadata: { name: sname, namespace: ns }, type: 'kubernetes.io/dockerconfigjson', data: { '.dockerconfigjson': btoa(JSON.stringify(auth)) } };
        } else if (stype === 'tls') {
          const rd = (p) => { try { return ctx.session.fs.readFile(ctx.session.resolvePath(p), ctx.session.user); } catch (e) { throw new KubectlError('error reading ' + p + ': no such file or directory'); } };
          need(flags.cert && flags.key, 'flag(s) --cert and --key are required');
          obj = { apiVersion: 'v1', kind: 'Secret', metadata: { name: sname, namespace: ns }, type: 'kubernetes.io/tls', data: { 'tls.crt': btoa(rd(flags.cert)), 'tls.key': btoa(rd(flags.key)) } };
        } else throw new KubectlError('unknown secret type "' + stype + '" (generic, docker-registry, tls)');
        break;
      }
      case 'serviceaccount': case 'sa':
        need(name, 'NAME is required');
        obj = { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name, namespace: ns } };
        break;
      case 'role': case 'clusterrole': {
        need(name, 'NAME is required');
        need(flags.verb && flags.verb.length, 'at least one verb must be specified');
        need(flags.resource && flags.resource.length, 'at least one resource must be specified');
        const verbs = flags.verb.flatMap(v => v.split(','));
        const rules = [];
        for (const r of flags.resource.flatMap(x => x.split(','))) {
          const [res, subres] = r.split('/');
          const e = t.cluster.kinds.resolve(res);
          if (!e) throw new KubectlError('the server doesn\'t have a resource type "' + res + '"');
          const resName = e.plural + (subres ? '/' + subres : '');
          let rule = rules.find(x => x.apiGroups[0] === e.group);
          if (!rule) { rule = { apiGroups: [e.group], resources: [], verbs }; rules.push(rule); }
          rule.resources.push(resName);
          if (flags['resource-name']) rule.resourceNames = flags['resource-name'].flatMap(x => x.split(','));
        }
        obj = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: sub === 'role' ? 'Role' : 'ClusterRole', metadata: { name }, rules };
        if (sub === 'role') obj.metadata.namespace = ns;
        break;
      }
      case 'rolebinding': case 'clusterrolebinding': {
        need(name, 'NAME is required');
        const roleRef = flags.clusterrole ? { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: flags.clusterrole } : flags.role ? { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: flags.role } : null;
        need(roleRef, sub === 'rolebinding' ? 'exactly one of clusterrole or role must be specified' : 'required flag(s) "clusterrole" not set');
        const subjects = [];
        for (const u of flags.user || []) subjects.push({ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: u });
        for (const g of flags.group || []) subjects.push({ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: g });
        for (const sa of flags.serviceaccount || []) { const [sns, sname] = sa.split(':'); need(sname, 'serviceaccount must be <namespace>:<name>'); subjects.push({ kind: 'ServiceAccount', name: sname, namespace: sns }); }
        obj = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: sub === 'rolebinding' ? 'RoleBinding' : 'ClusterRoleBinding', metadata: { name }, roleRef, subjects };
        if (sub === 'rolebinding') obj.metadata.namespace = ns;
        break;
      }
      case 'job': {
        need(name, 'NAME is required'); need(flags.image, 'required flag(s) "image" not set');
        const c = { name, image: flags.image, resources: {} };
        if (rest && rest.length) c.command = rest;
        obj = { apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace: ns }, spec: { template: { metadata: {}, spec: { containers: [c], restartPolicy: 'Never' } } } };
        break;
      }
      case 'cronjob': case 'cj': {
        need(name, 'NAME is required'); need(flags.image, 'required flag(s) "image" not set'); need(flags.schedule, 'required flag(s) "schedule" not set');
        const c = { name, image: flags.image, resources: {} };
        if (rest && rest.length) c.command = rest;
        obj = { apiVersion: 'batch/v1', kind: 'CronJob', metadata: { name, namespace: ns }, spec: { schedule: flags.schedule, jobTemplate: { metadata: {}, spec: { template: { metadata: {}, spec: { containers: [c], restartPolicy: 'OnFailure' } } } } } };
        break;
      }
      case 'ingress': case 'ing': {
        need(name, 'NAME is required'); need(flags.rule && flags.rule.length, 'required flag(s) "rule" not set');
        const rules = [];
        const tls = [];
        for (const r of flags.rule) {
          const m = r.match(/^([^/]*)(\/[^=]*)=([^:,]+):(\d+|[a-z0-9-]+)(?:,tls=?([^,]*))?$/);
          if (!m) throw new KubectlError('ingress rule "' + r + '" must be in the form host/path=service:port[,tls=secret]');
          const host = m[1] || undefined;
          let rule = rules.find(x => x.host === host);
          if (!rule) { rule = { http: { paths: [] } }; if (host) rule.host = host; rules.push(rule); }
          const port = /^\d+$/.test(m[4]) ? { number: parseInt(m[4], 10) } : { name: m[4] };
          const path = m[2].endsWith('*') ? m[2].slice(0, -1) : m[2];
          rule.http.paths.push({ path, pathType: m[2].endsWith('*') ? 'Prefix' : 'Exact', backend: { service: { name: m[3], port } } });
          if (m[5] !== undefined && host) tls.push({ hosts: [host], secretName: m[5] || undefined });
        }
        obj = { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name, namespace: ns }, spec: { rules } };
        if (flags.class) obj.spec.ingressClassName = flags.class;
        if (tls.length) obj.spec.tls = tls;
        if (flags.annotation) obj.metadata.annotations = Object.fromEntries([].concat(flags.annotation).map(a => a.split('=')));
        break;
      }
      case 'quota': case 'resourcequota': {
        need(name, 'NAME is required');
        obj = { apiVersion: 'v1', kind: 'ResourceQuota', metadata: { name, namespace: ns }, spec: { hard: Object.fromEntries((flags.hard || '').split(',').filter(Boolean).map(kv => kv.split('='))) } };
        break;
      }
      case 'priorityclass': case 'pc':
        need(name, 'NAME is required'); need(flags.value !== undefined, 'required flag(s) "value" not set');
        obj = { apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: { name }, value: parseInt(flags.value, 10), globalDefault: !!flags['global-default'], description: flags.description || '' };
        break;
      case 'poddisruptionbudget': case 'pdb': {
        need(name, 'NAME is required'); need(flags.selector, 'required flag(s) "selector" not set');
        obj = { apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { name, namespace: ns }, spec: { selector: parseLabelSelector(flags.selector) } };
        if (!obj.spec.selector.matchExpressions.length) delete obj.spec.selector.matchExpressions;
        if (flags['min-available'] !== undefined) obj.spec.minAvailable = /^\d+$/.test(flags['min-available']) ? parseInt(flags['min-available'], 10) : flags['min-available'];
        if (flags['max-unavailable'] !== undefined) obj.spec.maxUnavailable = /^\d+$/.test(flags['max-unavailable']) ? parseInt(flags['max-unavailable'], 10) : flags['max-unavailable'];
        break;
      }
      case 'token': {
        need(name, 'NAME is required');
        io.out('eyJhbGciOiJSUzI1NiIsImtpZCI6Ii' + shortHash(name + Date.now(), 40) + '.' + shortHash(name + 'payload', 60) + '.' + shortHash(name + 'sig', 43));
        return;
      }
      default:
        throw new KubectlError('unknown command "' + sub + '" for "kubectl create"');
    }
    if (flags.labels && obj.metadata) obj.metadata.labels = Object.assign({}, obj.metadata.labels || {}, labelsFromFlag());
    this.createObject(t, obj, flags, io, 'created');
  }

  containerName(image) {
    const base = image.split('/').pop().split('@')[0].split(':')[0];
    return base.replace(/[^a-z0-9-]/g, '-');
  }

  kvData(ctx, flags) {
    const data = {};
    for (const kv of flags['from-literal'] || []) {
      const i = kv.indexOf('=');
      if (i === -1) throw new KubectlError('invalid literal source ' + kv + ', expected key=value');
      data[kv.slice(0, i)] = kv.slice(i + 1);
    }
    for (const spec of flags['from-file'] || []) {
      let key, path;
      const i = spec.indexOf('=');
      if (i === -1) { path = spec; key = spec.split('/').pop(); } else { key = spec.slice(0, i); path = spec.slice(i + 1); }
      let text;
      try { text = ctx.session.fs.readFile(ctx.session.resolvePath(path), ctx.session.user); } catch (e) { throw new KubectlError('error reading ' + path + ': no such file or directory'); }
      data[key] = text;
    }
    for (const path of flags['from-env-file'] || []) {
      let text;
      try { text = ctx.session.fs.readFile(ctx.session.resolvePath(path), ctx.session.user); } catch (e) { throw new KubectlError('error reading ' + path + ': no such file or directory'); }
      for (const line of text.split('\n')) { const m = line.match(/^\s*([^#=\s]+)=(.*)$/); if (m) data[m[1]] = m[2]; }
    }
    return data;
  }

  createObject(t, obj, flags, io, verb) {
    this._cluster = t.cluster;
    const entry = t.cluster.entryFor(obj);
    if (entry.namespaced) {
      obj.metadata = obj.metadata || {};
      if (flags.namespace && obj.metadata.namespace && obj.metadata.namespace !== flags.namespace) {
        throw new KubectlError('the namespace from the provided object "' + obj.metadata.namespace + '" does not match the namespace "' + flags.namespace + '". You must pass \'--namespace=' + obj.metadata.namespace + '\' to perform this operation.');
      }
      obj.metadata.namespace = obj.metadata.namespace || t.ns;
    }
    if (flags['dry-run']) {
      if (flags.output === 'yaml' || flags.output === 'json') return this.emit(io, this.clientObject(obj), flags, verb);
      return io.out(t.cluster.kinds.fullName(entry, obj.metadata.name) + ' ' + verb + ' (dry run)');
    }
    const created = t.cluster.create(obj, { defaultNamespace: t.ns });
    Sim.reconcile(t.cluster);
    if (flags.output === 'yaml' || flags.output === 'json') return this.emit(io, created, flags, verb);
    io.out(t.cluster.kinds.fullName(entry, created.metadata.name) + ' ' + verb);
    return created;
  }

  /* ---------- run / expose / apply / delete ---------- */
  async cmd_run(ctx, { flags, positional, rest }, io) {
    const t = this.target(ctx, flags);
    this._cluster = t.cluster;
    const name = positional[0];
    if (!name) throw new KubectlError('NAME is required for run');
    if (!flags.image) throw new KubectlError('required flag(s) "image" not set');
    const labels = flags.labels ? Object.fromEntries(flags.labels.split(',').map(kv => kv.split('='))) : { run: name };
    const c = { name, image: flags.image, resources: {} };
    if (flags.port) c.ports = [{ containerPort: parseInt(flags.port, 10) }];
    if (flags.env) c.env = flags.env.map(e => { const i = e.indexOf('='); return { name: e.slice(0, i), value: e.slice(i + 1) }; });
    if (flags['image-pull-policy']) c.imagePullPolicy = flags['image-pull-policy'];
    if (rest && rest.length) { if (flags.command) c.command = rest; else c.args = rest; }
    const parseRes = (s) => Object.fromEntries(s.split(',').map(kv => kv.split('=')));
    if (flags.requests) c.resources.requests = parseRes(flags.requests);
    if (flags.limits) c.resources.limits = parseRes(flags.limits);
    const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: t.ns, labels }, spec: { containers: [c], dnsPolicy: 'ClusterFirst', restartPolicy: flags.restart || 'Always' } };
    if (flags.annotations) pod.metadata.annotations = Object.fromEntries(flags.annotations.split(',').map(kv => kv.split('=')));
    if (flags.overrides) { try { Object.assign(pod, deepMerge(pod, JSON.parse(flags.overrides))); } catch (e) { throw new KubectlError('invalid --overrides JSON'); } }
    if (flags['dry-run']) {
      if (flags.output === 'yaml' || flags.output === 'json') { const co = this.clientObject(pod); return this.emit(io, co, flags, 'created'); }
      return io.out('pod/' + name + ' created (dry run)');
    }
    const created = t.cluster.create(pod, { defaultNamespace: t.ns });
    Sim.reconcile(t.cluster);
    if (flags.expose) {
      if (!flags.port) throw new KubectlError('--port must be set when exposing a service');
      t.cluster.create({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: t.ns, labels }, spec: { selector: labels, ports: [{ port: parseInt(flags.port, 10), targetPort: parseInt(flags.port, 10), protocol: 'TCP' }] } });
      io.out('service/' + name + ' created');
    }
    if (flags.rm && rest && rest.length) {
      // interactive one-shot: run the command "inside" the pod, then delete it
      const stFake = t.cluster.simState(created); stFake.scheduledAt = Date.now() - 5000; stFake.createdAt = Date.now() - 5000;
      Sim.reconcile(t.cluster);
      const out = this.simulateExec(t, created, rest);
      if (out.text) io.out(out.text);
      if (out.error) io.err(out.error);
      t.cluster.removeObject(created, true);
      Sim.reconcile(t.cluster);
      io.out('pod "' + name + '" deleted');
      return;
    }
    if (flags.output === 'yaml' || flags.output === 'json') return this.emit(io, created, flags, 'created');
    io.out('pod/' + name + ' created');
  }

  cmd_expose(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags);
    this._cluster = t.cluster;
    const groups = this.parseResources(t.cluster, positional);
    if (groups.length !== 1 || groups[0].names.length !== 1) throw new KubectlError('exactly one resource must be specified');
    const entry = groups[0].entry;
    const obj = this.listObjs(t, entry, { names: groups[0].names })[0];
    let selector, containers;
    if (entry.kind === 'Pod') { selector = obj.metadata.labels || {}; containers = obj.spec.containers; }
    else if (['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet'].includes(entry.kind)) { selector = obj.spec.selector.matchLabels; containers = obj.spec.template.spec.containers; }
    else if (entry.kind === 'Service') { selector = obj.spec.selector; containers = []; }
    else throw new KubectlError('cannot expose a ' + entry.kind);
    if (!selector || !Object.keys(selector).length) throw new KubectlError('couldn\'t retrieve selectors via --selector flag or introspection');
    const name = flags.name || obj.metadata.name;
    let port = flags.port ? parseInt(flags.port, 10) : null;
    if (!port) {
      const cp = (containers || []).flatMap(c => c.ports || [])[0];
      if (!cp) throw new KubectlError('couldn\'t find port via --port flag or introspection');
      port = cp.containerPort;
    }
    const tp = flags['target-port'] ? (/^\d+$/.test(flags['target-port']) ? parseInt(flags['target-port'], 10) : flags['target-port']) : port;
    const svc = { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: t.ns, labels: obj.metadata.labels || {} }, spec: { selector, ports: [{ port, targetPort: tp, protocol: flags.protocol || 'TCP' }], type: flags.type || 'ClusterIP' } };
    if (flags.labels) svc.metadata.labels = Object.fromEntries(flags.labels.split(',').map(kv => kv.split('=')));
    if (flags['cluster-ip']) svc.spec.clusterIP = flags['cluster-ip'];
    if (flags['dry-run']) {
      if (flags.output === 'yaml' || flags.output === 'json') return this.emit(io, this.clientObject(svc), flags, 'exposed');
      return io.out('service/' + name + ' exposed (dry run)');
    }
    const created = t.cluster.create(svc);
    if (flags.output === 'yaml' || flags.output === 'json') return this.emit(io, created, flags, 'exposed');
    io.out('service/' + name + ' exposed');
  }

  cmd_apply(ctx, { flags }, io) {
    const t = this.target(ctx, flags);
    this._cluster = t.cluster;
    if (flags.kustomize) throw new KubectlError('kustomize (-k) is not supported in this simulator');
    const docs = this.readFiles(ctx, flags);
    for (const doc of docs) {
      const entry = t.cluster.entryFor(doc);
      doc.metadata = doc.metadata || {};
      if (entry.namespaced) {
        if (flags.namespace && doc.metadata.namespace && doc.metadata.namespace !== flags.namespace) throw new KubectlError('the namespace from the provided object "' + doc.metadata.namespace + '" does not match the namespace "' + flags.namespace + '". You must pass \'--namespace=' + doc.metadata.namespace + '\' to perform this operation.');
        doc.metadata.namespace = doc.metadata.namespace || t.ns;
      }
      if (flags['dry-run']) {
        const exists = t.cluster.get(entry, doc.metadata.namespace, doc.metadata.name);
        if (flags.output === 'yaml' || flags.output === 'json') this.emit(io, this.clientObject(doc), flags, 'x');
        else io.out(t.cluster.kinds.fullName(entry, doc.metadata.name) + ' ' + (exists ? 'configured' : 'created') + ' (dry run)');
        continue;
      }
      const { obj, action } = t.cluster.apply(doc, { defaultNamespace: t.ns });
      Sim.reconcile(t.cluster);
      if (flags.output === 'yaml' || flags.output === 'json') this.emit(io, obj, flags, action);
      else io.out(t.cluster.kinds.fullName(entry, obj.metadata.name) + ' ' + action);
    }
  }

  cmd_replace(ctx, { flags }, io) {
    const t = this.target(ctx, flags);
    this._cluster = t.cluster;
    for (const doc of this.readFiles(ctx, flags)) {
      const entry = t.cluster.entryFor(doc);
      if (entry.namespaced) doc.metadata.namespace = doc.metadata.namespace || t.ns;
      if (flags.force) {
        const ex = t.cluster.get(entry, doc.metadata.namespace, doc.metadata.name);
        if (ex) { t.cluster.removeObject(ex, true); io.out(entry.singular + (entry.group ? '.' + entry.group : '') + ' "' + doc.metadata.name + '" deleted'); }
        const c = t.cluster.create(doc); Sim.reconcile(t.cluster);
        io.out(t.cluster.kinds.fullName(entry, c.metadata.name) + ' replaced');
        continue;
      }
      const u = t.cluster.update(doc); Sim.reconcile(t.cluster);
      io.out(t.cluster.kinds.fullName(entry, u.metadata.name) + ' replaced');
    }
  }

  cmd_delete(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags);
    this._cluster = t.cluster;
    const targets = [];
    if (flags.filename) {
      for (const doc of this.readFiles(ctx, flags)) {
        const entry = t.cluster.entryFor(doc);
        targets.push({ entry, ns: entry.namespaced ? (doc.metadata.namespace || t.ns) : null, name: doc.metadata.name });
      }
    } else {
      const groups = this.parseResources(t.cluster, positional);
      for (const g of groups) {
        if (g.names.length) { for (const n of g.names) targets.push({ entry: g.entry, ns: t.ns, name: n }); continue; }
        if (!flags.selector && !flags.all) throw new KubectlError('resource(s) were provided, but no name was specified');
        for (const o of this.listObjs(t, g.entry, { selector: flags.selector ? parseLabelSelector(flags.selector) : null })) targets.push({ entry: g.entry, ns: o.metadata.namespace, name: o.metadata.name });
      }
    }
    if (flags.force && (flags['grace-period'] === '0' || flags['grace-period'] === 0)) io.err('Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.');
    for (const x of targets) {
      const label = x.entry.singular + (x.entry.group ? '.' + x.entry.group : '');
      try {
        t.cluster.delete(x.entry, x.ns, x.name, { cascade: flags.cascade !== 'orphan' });
        io.out(label + ' "' + x.name + '" deleted');
      } catch (e) {
        if (e instanceof ApiError && flags['ignore-not-found']) continue;
        if (e instanceof ApiError) io.err(e.toString()); else throw e;
      }
    }
    Sim.reconcile(t.cluster);
    if (!targets.length) io.out('No resources found');
  }

  /* ---------- scale / autoscale / set / rollout ---------- */
  workloadTargets(t, flags, positional, kinds) {
    if (flags.filename) return this.readFiles({ session: this._ctxSession }, flags).map(d => ({ entry: t.cluster.entryFor(d), obj: t.cluster.get(t.cluster.entryFor(d), d.metadata.namespace || t.ns, d.metadata.name) })).filter(x => x.obj);
    const groups = this.parseResources(t.cluster, positional);
    const out = [];
    for (const g of groups) {
      if (kinds && !kinds.includes(g.entry.kind)) throw new KubectlError('cannot ' + flags._verb + ' a ' + g.entry.kind);
      for (const o of this.listObjs(t, g.entry, { names: g.names, selector: flags.selector ? parseLabelSelector(flags.selector) : null })) out.push({ entry: g.entry, obj: o });
    }
    return out;
  }

  cmd_scale(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags);
    this._cluster = t.cluster; this._ctxSession = ctx.session;
    if (flags.replicas === undefined) throw new KubectlError('required flag(s) "replicas" not set');
    const n = parseInt(flags.replicas, 10);
    for (const { entry, obj } of this.workloadTargets(t, flags, positional, ['Deployment', 'ReplicaSet', 'StatefulSet', 'ReplicationController'])) {
      obj.spec.replicas = n;
      obj.metadata.generation = (obj.metadata.generation || 1) + 1;
      io.out(t.cluster.kinds.fullName(entry, obj.metadata.name) + ' scaled');
    }
    Sim.reconcile(t.cluster);
  }

  cmd_autoscale(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags);
    this._cluster = t.cluster; this._ctxSession = ctx.session;
    if (flags.max === undefined) throw new KubectlError('required flag(s) "max" not set');
    for (const { entry, obj } of this.workloadTargets(t, flags, positional, ['Deployment', 'ReplicaSet', 'StatefulSet'])) {
      const hpa = { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler', metadata: { name: flags.name || obj.metadata.name, namespace: obj.metadata.namespace },
        spec: { scaleTargetRef: { apiVersion: obj.apiVersion, kind: obj.kind, name: obj.metadata.name }, minReplicas: parseInt(flags.min || '1', 10), maxReplicas: parseInt(flags.max, 10),
          metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: parseInt(flags['cpu-percent'] || '80', 10) } } }] } };
      if (flags['dry-run']) { if (flags.output === 'yaml' || flags.output === 'json') this.emit(io, this.clientObject(hpa), flags, 'autoscaled'); else io.out('horizontalpodautoscaler.autoscaling/' + hpa.metadata.name + ' autoscaled (dry run)'); continue; }
      t.cluster.create(hpa);
      io.out('horizontalpodautoscaler.autoscaling/' + hpa.metadata.name + ' autoscaled');
    }
  }

  cmd_set(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags);
    this._cluster = t.cluster; this._ctxSession = ctx.session;
    const sub = positional[0];
    const rest = positional.slice(1);
    const isKv = (s) => /^[^=]+=.+$/.test(s) || /^[^=]+-$/.test(s);
    const resArgs = rest.filter(a => !isKv(a) || (sub === 'image' && !a.includes('=')));
    const kvs = rest.filter(isKv);
    if (sub === 'image') {
      const resPos = rest.filter(a => !a.includes('='));
      const imgs = rest.filter(a => a.includes('='));
      if (!imgs.length) throw new KubectlError('at least one image update is required');
      for (const { entry, obj } of this.workloadTargets(t, flags, resPos)) {
        const spec = entry.kind === 'Pod' ? obj.spec : obj.spec.template.spec;
        let changed = false;
        for (const kv of imgs) {
          const [cname, image] = kv.split('=');
          for (const c of [...(spec.containers || []), ...(spec.initContainers || [])]) {
            if (cname === '*' || c.name === cname) { if (c.image !== image) { c.image = image; changed = true; } }
          }
          if (cname !== '*' && !(spec.containers || []).some(c => c.name === cname) && !(spec.initContainers || []).some(c => c.name === cname)) throw new KubectlError('unable to find container named "' + cname + '"');
        }
        if (changed) obj.metadata.generation = (obj.metadata.generation || 1) + 1;
        if (flags['dry-run']) { if (flags.output === 'yaml' || flags.output === 'json') this.emit(io, obj, flags, 'x'); else io.out(t.cluster.kinds.fullName(entry, obj.metadata.name) + ' image updated (dry run)'); continue; }
        io.out(t.cluster.kinds.fullName(entry, obj.metadata.name) + ' image updated');
      }
      Sim.reconcile(t.cluster);
      return;
    }
    if (sub === 'env') {
      for (const { entry, obj } of this.workloadTargets(t, flags, resArgs)) {
        const spec = entry.kind === 'Pod' ? obj.spec : obj.spec.template.spec;
        for (const c of spec.containers) {
          if (flags.container && c.name !== flags.container) continue;
          c.env = c.env || [];
          for (const kv of kvs) {
            if (kv.endsWith('-')) { c.env = c.env.filter(e => e.name !== kv.slice(0, -1)); continue; }
            const i = kv.indexOf('='); const name = kv.slice(0, i), value = kv.slice(i + 1);
            const ex = c.env.find(e => e.name === name);
            if (ex) ex.value = value; else c.env.push({ name, value });
          }
          if (!c.env.length) delete c.env;
        }
        obj.metadata.generation = (obj.metadata.generation || 1) + 1;
        io.out(t.cluster.kinds.fullName(entry, obj.metadata.name) + ' env updated');
      }
      Sim.reconcile(t.cluster);
      return;
    }
    if (sub === 'resources') {
      const parseRes = (s) => Object.fromEntries(s.split(',').map(kv => kv.split('=')));
      for (const { entry, obj } of this.workloadTargets(t, flags, resArgs)) {
        const spec = entry.kind === 'Pod' ? obj.spec : obj.spec.template.spec;
        for (const c of spec.containers) {
          if (flags.container && c.name !== flags.container) continue;
          c.resources = c.resources || {};
          if (flags.limits) c.resources.limits = Object.assign({}, c.resources.limits, parseRes(flags.limits));
          if (flags.requests) c.resources.requests = Object.assign({}, c.resources.requests, parseRes(flags.requests));
        }
        obj.metadata.generation = (obj.metadata.generation || 1) + 1;
        io.out(t.cluster.kinds.fullName(entry, obj.metadata.name) + ' resource requirements updated');
      }
      Sim.reconcile(t.cluster);
      return;
    }
    if (sub === 'serviceaccount' || sub === 'sa') {
      const sa = rest[rest.length - 1];
      for (const { entry, obj } of this.workloadTargets(t, flags, rest.slice(0, -1))) {
        const spec = entry.kind === 'Pod' ? obj.spec : obj.spec.template.spec;
        spec.serviceAccountName = sa; spec.serviceAccount = sa;
        obj.metadata.generation = (obj.metadata.generation || 1) + 1;
        io.out(t.cluster.kinds.fullName(entry, obj.metadata.name) + ' serviceaccount updated');
      }
      Sim.reconcile(t.cluster);
      return;
    }
    if (sub === 'selector') {
      const svcs = this.workloadTargets(t, flags, [resArgs[0]], ['Service']);
      for (const { obj } of svcs) { obj.spec.selector = Object.fromEntries(kvs.map(kv => kv.split('='))); io.out('service/' + obj.metadata.name + ' selector updated'); }
      return;
    }
    throw new KubectlError('unknown command "' + sub + '" for "kubectl set" (image, env, resources, serviceaccount, selector)');
  }

  async cmd_rollout(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags);
    this._cluster = t.cluster; this._ctxSession = ctx.session;
    const sub = positional[0];
    const targets = this.workloadTargets(t, flags, positional.slice(1), ['Deployment', 'DaemonSet', 'StatefulSet']);
    if (!targets.length) throw new KubectlError('required resource not specified');
    for (const { entry, obj } of targets) {
      const full = t.cluster.kinds.fullName(entry, obj.metadata.name);
      const kindWord = entry.kind === 'Deployment' ? 'deployment' : entry.kind === 'DaemonSet' ? 'daemon set' : 'statefulset';
      if (sub === 'status') {
        const deadline = Date.now() + 25000;
        let last = '';
        while (true) {
          Sim.reconcile(t.cluster);
          const s = obj.status || {};
          const want = entry.kind === 'DaemonSet' ? s.desiredNumberScheduled : obj.spec.replicas;
          const ready = entry.kind === 'DaemonSet' ? s.numberReady : (s.readyReplicas || 0);
          const updated = entry.kind === 'DaemonSet' ? s.updatedNumberScheduled : (s.updatedReplicas || 0);
          if (ready >= want && updated >= want && (entry.kind !== 'Deployment' || (s.replicas || 0) === want)) { io.out(kindWord + ' "' + obj.metadata.name + '" successfully rolled out'); break; }
          const msg = 'Waiting for ' + kindWord + ' "' + obj.metadata.name + '" rollout to finish: ' + (updated < want ? updated + ' out of ' + want + ' new replicas have been updated...' : ready + ' of ' + want + ' updated replicas are available...');
          if (msg !== last) { io.out(msg); last = msg; }
          if (Date.now() > deadline) { io.err('error: timed out waiting for the condition'); break; }
          await new Promise(r => setTimeout(r, 700));
        }
        continue;
      }
      if (entry.kind !== 'Deployment' && sub !== 'restart') throw new KubectlError(sub + ' is only supported for deployments in this simulator');
      if (sub === 'history') {
        const hist = (t.cluster.history.get(t.cluster.keyOf(obj)) || []).slice().sort((a, b) => a.revision - b.revision);
        if (flags.revision) {
          const h = hist.find(x => String(x.revision) === String(flags.revision));
          if (!h) throw new KubectlError('unable to find the specified revision');
          io.out(full + ' with revision #' + h.revision + '\nPod Template:\n  Labels:\t' + Printers.labelsString(h.template.metadata.labels).replace(/,/g, '\n\t\t') + '\n  Containers:\n' + h.template.spec.containers.map(c => '   ' + c.name + ':\n    Image:\t' + c.image + '\n    Port:\t' + ((c.ports || []).map(p => p.containerPort + '/' + (p.protocol || 'TCP')).join(', ') || '<none>') + '\n    Host Port:\t' + ((c.ports || []).map(() => '0/TCP').join(', ') || '<none>') + '\n    Environment:\t<none>\n    Mounts:\t<none>').join('\n') + '\n  Volumes:\t<none>\n  Node-Selectors:\t<none>\n  Tolerations:\t<none>');
          continue;
        }
        io.out(full + ' \n' + Printers.table(['REVISION', 'CHANGE-CAUSE'], hist.map(h => [String(h.revision), h.cause || '<none>'])).replace(/   /g, '  '));
        continue;
      }
      if (sub === 'undo') {
        const hist = (t.cluster.history.get(t.cluster.keyOf(obj)) || []).slice().sort((a, b) => a.revision - b.revision);
        const cur = hist[hist.length - 1];
        let target;
        if (flags['to-revision']) target = hist.find(h => String(h.revision) === String(flags['to-revision']));
        else target = hist[hist.length - 2];
        if (!target) throw new KubectlError(flags['to-revision'] ? 'unable to find specified revision ' + flags['to-revision'] + ' in history' : 'no rollout history found for ' + full);
        if (cur && target.revision === cur.revision) { io.out('skipped rollback (current template already matches revision ' + cur.revision + ')'); continue; }
        obj.spec.template = deepClone(target.template);
        obj.metadata.generation = (obj.metadata.generation || 1) + 1;
        io.out(full + ' rolled back');
        continue;
      }
      if (sub === 'restart') {
        obj.spec.template.metadata.annotations = Object.assign({}, obj.spec.template.metadata.annotations, { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString().replace(/\.\d+Z$/, 'Z') });
        obj.metadata.generation = (obj.metadata.generation || 1) + 1;
        io.out(full + ' restarted');
        continue;
      }
      if (sub === 'pause') { obj.spec.paused = true; io.out(full + ' paused'); continue; }
      if (sub === 'resume') { delete obj.spec.paused; io.out(full + ' resumed'); continue; }
      throw new KubectlError('unknown command "' + sub + '" for "kubectl rollout" (status, history, undo, restart, pause, resume)');
    }
    Sim.reconcile(t.cluster);
  }

  /* ---------- label / annotate / taint / cordon / drain ---------- */
  metaEdit(ctx, { flags, positional }, io, field) {
    const t = this.target(ctx, flags);
    this._cluster = t.cluster; this._ctxSession = ctx.session;
    const isKv = (s) => /^[^=]+=/.test(s) || /^[^=\/]+-$/.test(s);
    const resArgs = positional.filter(a => !isKv(a));
    const kvs = positional.filter(isKv);
    if (!kvs.length) throw new KubectlError('at least one ' + field.slice(0, -1) + ' update is required');
    const past = field === 'labels' ? 'labeled' : 'annotated';
    const objs = flags.filename ? this.readFiles(ctx, flags).map(d => ({ entry: t.cluster.entryFor(d), obj: t.cluster.get(t.cluster.entryFor(d), d.metadata.namespace || t.ns, d.metadata.name) })).filter(x => x.obj) : this.workloadTargets(t, flags, resArgs);
    if (!objs.length && flags.all) throw new KubectlError('no resources found');
    for (const { entry, obj } of objs) {
      const map = Object.assign({}, obj.metadata[field] || {});
      let changed = false;
      for (const kv of kvs) {
        if (kv.endsWith('-') && !kv.includes('=')) { const k = kv.slice(0, -1); if (k in map) { delete map[k]; changed = true; } continue; }
        const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1);
        if (k in map && map[k] !== v && !flags.overwrite) throw new KubectlError('\'' + k + '\' already has a value (' + map[k] + '), and --overwrite is false');
        if (map[k] !== v) { map[k] = v; changed = true; }
      }
      if (Object.keys(map).length) obj.metadata[field] = map; else delete obj.metadata[field];
      obj.metadata.resourceVersion = String(t.cluster.rv++);
      io.out(t.cluster.kinds.fullName(entry, obj.metadata.name) + ' ' + (changed ? past : 'not ' + past));
    }
    Sim.reconcile(t.cluster);
  }
  cmd_label(ctx, parsed, io) { return this.metaEdit(ctx, parsed, io, 'labels'); }
  cmd_annotate(ctx, parsed, io) { return this.metaEdit(ctx, parsed, io, 'annotations'); }

  cmd_taint(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags);
    if (positional[0] !== 'nodes' && positional[0] !== 'node' && positional[0] !== 'no') throw new KubectlError('invalid resource type ' + positional[0] + ', only node(s) is supported');
    const isTaint = (s) => /^[^=:]+(=[^:]*)?:(NoSchedule|NoExecute|PreferNoSchedule)-?$/.test(s) || /^[^=:]+-$/.test(s);
    const taintArgs = positional.slice(1).filter(isTaint);
    const nodeNames = positional.slice(1).filter(a => !isTaint(a));
    if (!taintArgs.length) throw new KubectlError('at least one taint update is required');
    const nodes = flags.all ? t.cluster.nodes() : flags.selector ? t.cluster.nodes().filter(n => labelsMatch(parseLabelSelector(flags.selector), n.metadata.labels)) : nodeNames.map(n => { const node = t.cluster.node(n); if (!node) throw new ApiError('NotFound', 'nodes "' + n + '" not found'); return node; });
    for (const node of nodes) {
      let taints = (node.spec.taints || []).filter(x => !x.key.startsWith('node.kubernetes.io/'));
      let removed = false, added = false;
      for (const ta of taintArgs) {
        if (ta.endsWith('-')) {
          const spec = ta.slice(0, -1);
          const [kv, effect] = spec.split(':');
          const key = kv.split('=')[0];
          const before = taints.length;
          taints = taints.filter(x => !(x.key === key && (!effect || x.effect === effect)));
          if (taints.length === before) throw new KubectlError('taint "' + spec + '" not found');
          removed = true;
          continue;
        }
        const [kv, effect] = ta.split(':');
        const [key, value] = kv.split('=');
        const ex = taints.find(x => x.key === key && x.effect === effect);
        if (ex && !flags.overwrite) throw new KubectlError('node ' + node.metadata.name + ' already has ' + key + ' taint(s) with same effect(s) and --overwrite is false');
        if (ex) ex.value = value; else taints.push(Object.assign({ key, effect }, value !== undefined ? { value } : {}));
        added = true;
      }
      node.spec.taints = taints.length ? taints : undefined;
      if (!node.spec.taints) delete node.spec.taints;
      io.out('node/' + node.metadata.name + (added ? ' tainted' : removed ? ' untainted' : ' not tainted'));
    }
    Sim.reconcile(t.cluster);
  }

  cmd_cordon(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags);
    for (const n of positional) {
      const node = t.cluster.node(n.replace(/^nodes?\//, ''));
      if (!node) throw new ApiError('NotFound', 'nodes "' + n + '" not found');
      if (node.spec.unschedulable) { io.out('node/' + node.metadata.name + ' already cordoned'); continue; }
      node.spec.unschedulable = true;
      io.out('node/' + node.metadata.name + ' cordoned');
    }
    Sim.reconcile(t.cluster);
  }
  cmd_uncordon(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags);
    for (const n of positional) {
      const node = t.cluster.node(n.replace(/^nodes?\//, ''));
      if (!node) throw new ApiError('NotFound', 'nodes "' + n + '" not found');
      if (!node.spec.unschedulable) { io.out('node/' + node.metadata.name + ' already uncordoned'); continue; }
      delete node.spec.unschedulable;
      io.out('node/' + node.metadata.name + ' uncordoned');
    }
    Sim.reconcile(t.cluster);
  }
  cmd_drain(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags);
    if (!positional.length) throw new KubectlError('USAGE: drain <node name> [flags]');
    for (const n of positional) {
      const node = t.cluster.node(n.replace(/^nodes?\//, ''));
      if (!node) throw new ApiError('NotFound', 'nodes "' + n + '" not found');
      const pods = t.cluster.list(t.cluster.kinds.resolve('pod'), null).filter(p => p.spec.nodeName === node.metadata.name);
      const isDs = (p) => (p.metadata.ownerReferences || []).some(r => r.kind === 'DaemonSet');
      const isMirror = (p) => (p.metadata.annotations || {})['kubernetes.io/config.mirror'] !== undefined || (p.metadata.ownerReferences || []).some(r => r.kind === 'Node');
      const unmanaged = pods.filter(p => !(p.metadata.ownerReferences || []).length);
      const ds = pods.filter(isDs);
      const emptyDir = pods.filter(p => !isDs(p) && !isMirror(p) && (p.spec.volumes || []).some(v => v.emptyDir));
      const errs = [];
      if (unmanaged.length && !flags.force) errs.push('cannot delete Pods that declare no controller (use --force to override): ' + unmanaged.map(p => p.metadata.namespace + '/' + p.metadata.name).join(', '));
      if (ds.length && !flags['ignore-daemonsets']) errs.push('cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore): ' + ds.map(p => p.metadata.namespace + '/' + p.metadata.name).join(', '));
      if (emptyDir.length && !flags['delete-emptydir-data'] && !flags['delete-local-data']) errs.push('cannot delete Pods with local storage (use --delete-emptydir-data to override): ' + emptyDir.map(p => p.metadata.namespace + '/' + p.metadata.name).join(', '));
      if (!node.spec.unschedulable) { node.spec.unschedulable = true; io.out('node/' + node.metadata.name + ' cordoned'); } else io.out('node/' + node.metadata.name + ' already cordoned');
      if (errs.length) throw new KubectlError('unable to drain node "' + node.metadata.name + '" due to error: [' + errs.join(', ') + '], continuing command...\nThere are pending nodes to be drained:\n ' + node.metadata.name + '\n' + errs.map(e => 'error: ' + e).join('\n'));
      if (ds.length) io.err('Warning: ignoring DaemonSet-managed Pods: ' + ds.map(p => p.metadata.namespace + '/' + p.metadata.name).join(', '));
      for (const p of pods) {
        if (isDs(p) || isMirror(p)) continue;
        io.out('evicting pod ' + p.metadata.namespace + '/' + p.metadata.name);
        t.cluster.removeObject(p, false);
      }
      for (const p of pods) if (!isDs(p) && !isMirror(p)) io.out('pod/' + p.metadata.name + ' evicted');
      io.out('node/' + node.metadata.name + ' drained');
    }
    Sim.reconcile(t.cluster);
  }

  /* ---------- logs / exec / top ---------- */
  cmd_logs(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags);
    let pods;
    if (flags.selector) pods = this.listObjs(t, t.cluster.kinds.resolve('pod'), { selector: parseLabelSelector(flags.selector) });
    else {
      if (!positional.length) throw new KubectlError('expected \'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]\'.\nPOD or TYPE/NAME is a required argument for the logs command');
      const arg = positional[0];
      if (arg.includes('/')) {
        const [k, name] = arg.split('/');
        const entry = t.cluster.kinds.resolve(k);
        if (!entry) throw new KubectlError('the server doesn\'t have a resource type "' + k + '"');
        if (entry.kind === 'Pod') pods = [this.listObjs(t, entry, { names: [name] })[0]];
        else {
          const obj = this.listObjs(t, entry, { names: [name] })[0];
          const sel = obj.spec.selector.matchLabels || obj.spec.selector;
          pods = t.cluster.list(t.cluster.kinds.resolve('pod'), t.ns).filter(p => labelsMatch({ matchLabels: sel }, p.metadata.labels)).slice(0, 1);
          if (!pods.length) throw new KubectlError('no pods found for ' + arg);
          io.out('Found ' + pods.length + ' pods, using pod/' + pods[0].metadata.name);
        }
      } else pods = [this.listObjs(t, t.cluster.kinds.resolve('pod'), { names: [arg] })[0]];
    }
    for (const pod of pods) {
      const containers = pod.spec.containers;
      let cname = flags.container;
      if (!cname && containers.length > 1 && !flags['all-containers']) throw new KubectlError('a container name must be specified for pod ' + pod.metadata.name + ', choose one of: [' + containers.map(c => c.name).join(' ') + ']' + ((pod.spec.initContainers || []).length ? ' or one of the init containers: [' + pod.spec.initContainers.map(c => c.name).join(' ') + ']' : ''));
      const targets = flags['all-containers'] ? containers : [containers.find(c => c.name === (cname || containers[0].name)) || (pod.spec.initContainers || []).find(c => c.name === cname)];
      if (!targets[0]) throw new KubectlError('container ' + cname + ' is not valid for pod ' + pod.metadata.name);
      for (const c of targets) {
        const lines = this.podLogs(t.cluster, pod, c, !!flags.previous);
        let out = lines;
        if (flags.tail !== undefined && parseInt(flags.tail, 10) >= 0) out = lines.slice(-parseInt(flags.tail, 10));
        if (flags.timestamps) out = out.map(l => new Date().toISOString() + ' ' + l);
        if (out.length) io.out(out.join('\n'));
      }
    }
  }

  podLogs(cluster, pod, c, previous) {
    const st = cluster.simState(pod);
    const info = st.info || Sim.podPhaseInfo(cluster, pod, Date.now());
    const cs = info.cstates.find(x => x.name === c.name) || {};
    if (!pod.spec.nodeName) throw new ApiError('BadRequest', 'container "' + c.name + '" in pod "' + pod.metadata.name + '" is waiting to start: ContainerCreating');
    if (cs.state && cs.state.waiting && (cs.state.waiting.reason === 'ErrImagePull' || cs.state.waiting.reason === 'ImagePullBackOff')) throw new ApiError('BadRequest', 'container "' + c.name + '" in pod "' + pod.metadata.name + '" is waiting to start: trying and failing to pull image');
    if (cs.state && cs.state.waiting && cs.state.waiting.reason === 'ContainerCreating') throw new ApiError('BadRequest', 'container "' + c.name + '" in pod "' + pod.metadata.name + '" is waiting to start: ContainerCreating');
    if (previous && !(cs.restartCount > 0)) throw new ApiError('BadRequest', 'previous terminated container "' + c.name + '" in pod "' + pod.metadata.name + '" not found');
    const custom = st.logs && (typeof st.logs === 'object' && !Array.isArray(st.logs) ? st.logs[c.name] : st.logs);
    if (custom) return Array.isArray(custom) ? custom : String(custom).replace(/\n$/, '').split('\n');
    const img = c.image || '';
    const crashing = cs.state && ((cs.state.waiting && cs.state.waiting.reason === 'CrashLoopBackOff') || cs.lastState);
    if (crashing || previous) {
      const cmd = (c.command || []).concat(c.args || []).join(' ');
      if (st.crashLogs) return Array.isArray(st.crashLogs) ? st.crashLogs : String(st.crashLogs).split('\n');
      return ['Error: ' + (cmd.includes('exit') ? 'command exited with status 1: ' + cmd : 'failed to start application'), 'exit status 1'];
    }
    if (/nginx/.test(img)) return ['/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration', '/docker-entrypoint.sh: Looking for shell scripts in /docker-entrypoint.d/', '/docker-entrypoint.sh: Launching /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh', '10-listen-on-ipv6-by-default.sh: info: Getting the checksum of /etc/nginx/conf.d/default.conf', '10-listen-on-ipv6-by-default.sh: info: Enabled listen on IPv6 in /etc/nginx/conf.d/default.conf', '/docker-entrypoint.sh: Configuration complete; ready for start up', new Date().toISOString().replace('T', ' ').slice(0, 19) + ' [notice] 1#1: using the "epoll" event method', new Date().toISOString().replace('T', ' ').slice(0, 19) + ' [notice] 1#1: nginx/' + (img.match(/:(\d+\.\d+(?:\.\d+)?)/) || [, '1.27.0'])[1], new Date().toISOString().replace('T', ' ').slice(0, 19) + ' [notice] 1#1: start worker processes'];
    if (/redis/.test(img)) return ['1:C ' + new Date().toUTCString() + ' * oO0OoO0OoO0Oo Redis is starting oO0OoO0OoO0Oo', '1:M ' + new Date().toUTCString() + ' * Running mode=standalone, port=6379.', '1:M ' + new Date().toUTCString() + ' * Ready to accept connections tcp'];
    if (/httpd/.test(img)) return ['AH00558: httpd: Could not reliably determine the server\'s fully qualified domain name, using ' + (pod.status && pod.status.podIP) + '. Set the \'ServerName\' directive globally to suppress this message', '[' + new Date().toUTCString() + '] [mpm_event:notice] [pid 1:tid 1] AH00489: Apache/2.4.62 (Unix) configured -- resuming normal operations'];
    if (/coredns/.test(img)) return ['.:53', '[INFO] plugin/reload: Running configuration SHA512 = ' + shortHash(pod.metadata.name, 64), 'CoreDNS-1.11.3', 'linux/amd64, go1.21.11, a6338e9'];
    if (/kube-proxy|kube-apiserver|kube-scheduler|kube-controller|etcd|flannel|metrics-server/.test(img)) return ['I' + new Date().toISOString().slice(5, 10).replace('-', '') + ' ' + new Date().toISOString().slice(11, 23) + '       1 server.go:96] "Starting ' + c.name + '" version="v' + cluster.version + '"', 'I' + new Date().toISOString().slice(5, 10).replace('-', '') + ' ' + new Date().toISOString().slice(11, 23) + '       1 config.go:120] "Initialized"'];
    const cmd = (c.command || []).concat(c.args || []).join(' ');
    const echo = cmd.match(/echo\s+(.+?)(?:\s*;|\s*&&|$)/);
    if (echo) return [echo[1].replace(/^['"]|['"]$/g, '')];
    return [];
  }

  cmd_exec(ctx, { flags, positional, rest }, io) {
    const t = this.target(ctx, flags);
    const arg = positional[0];
    if (!arg) throw new KubectlError('pod, type/name or --filename must be specified');
    let cmd = rest;
    if (!cmd || !cmd.length) { cmd = positional.slice(1); if (!cmd.length) throw new KubectlError('you must specify at least one command for the container'); }
    let pod;
    if (arg.includes('/')) { const [k, n] = arg.split('/'); const e = t.cluster.kinds.resolve(k); if (!e) throw new KubectlError('the server doesn\'t have a resource type "' + k + '"'); const obj = this.listObjs(t, e, { names: [n] })[0]; pod = e.kind === 'Pod' ? obj : t.cluster.list(t.cluster.kinds.resolve('pod'), t.ns).filter(p => labelsMatch({ matchLabels: obj.spec.selector.matchLabels || obj.spec.selector }, p.metadata.labels))[0]; if (!pod) throw new KubectlError('no pods found for ' + arg); }
    else pod = this.listObjs(t, t.cluster.kinds.resolve('pod'), { names: [arg] })[0];
    const info = Printers.podInfo(t.cluster, pod);
    if (info.phase !== 'Running' || !info.cstates.some(c => c.state && c.state.running)) throw new ApiError('BadRequest', 'pod ' + pod.metadata.name + ' does not have a host assigned'.replace(/does not have a host assigned/, info.phase === 'Pending' && !pod.spec.nodeName ? 'does not have a host assigned' : 'is not running'));
    if (flags.container && !pod.spec.containers.some(c => c.name === flags.container)) throw new ApiError('BadRequest', 'container ' + flags.container + ' is not valid for pod ' + pod.metadata.name);
    if (pod.spec.containers.length > 1 && !flags.container) io.err('Defaulted container "' + pod.spec.containers[0].name + '" out of: ' + pod.spec.containers.map(c => c.name).join(', '));
    const out = this.simulateExec(t, pod, cmd, flags.container);
    if (out.text) io.out(out.text);
    if (out.error) { io.err(out.error); if (out.code) io.err('command terminated with exit code ' + out.code); }
  }

  /* A tiny "shell" inside the container. Enough for the exam's checks. */
  simulateExec(t, pod, argv, containerName) {
    const cluster = t.cluster;
    const c = pod.spec.containers.find(x => x.name === containerName) || pod.spec.containers[0];
    let cmd = argv.slice();
    if ((cmd[0] === 'sh' || cmd[0] === 'bash' || cmd[0] === '/bin/sh' || cmd[0] === '/bin/bash') && cmd[1] === '-c') {
      const inner = tokenize(cmd.slice(2).join(' '));
      cmd = inner.tokens || [];
    }
    if ((cmd[0] === 'sh' || cmd[0] === 'bash' || cmd[0] === '/bin/sh' || cmd[0] === '/bin/bash') && cmd.length === 1) return { text: '(interactive shells are not supported in this simulator — run a single command instead, e.g. -- cat /etc/hostname)' };
    const name = cmd[0];
    const env = this.podEnv(cluster, pod, c);
    switch (name) {
      case 'env': case 'printenv': return { text: cmd[1] ? (env[cmd[1]] !== undefined ? env[cmd[1]] : '') : Object.entries(env).map(([k, v]) => k + '=' + v).join('\n') };
      case 'echo': return { text: cmd.slice(1).map(a => a.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (m, k) => env[k] || '')).join(' ') };
      case 'hostname': return { text: pod.metadata.name };
      case 'id': return { text: 'uid=' + (c.securityContext && c.securityContext.runAsUser !== undefined ? c.securityContext.runAsUser + '(' + (c.securityContext.runAsUser === 0 ? 'root' : 'app') + ')' : '0(root)') + ' gid=0(root) groups=0(root)' };
      case 'whoami': return { text: c.securityContext && c.securityContext.runAsUser ? 'app' : 'root' };
      case 'ps': return { text: 'PID   USER     TIME  COMMAND\n    1 root      0:00 ' + ((c.command || []).concat(c.args || []).join(' ') || (/nginx/.test(c.image) ? 'nginx: master process nginx -g daemon off;' : /redis/.test(c.image) ? 'redis-server *:6379' : 'sleep 3600')) };
      case 'sleep': case 'true': return { text: '' };
      case 'cat': { const f = cmd[1]; if (!f) return { error: 'cat: missing file', code: 1 }; const r = this.podFile(cluster, pod, c, f); return r === null ? { error: 'cat: can\'t open \'' + f + '\': No such file or directory', code: 1 } : { text: r.replace(/\n$/, '') }; }
      case 'ls': { const d = cmd.filter(a => !a.startsWith('-'))[1] || '/'; const list = this.podLs(cluster, pod, c, d); return list === null ? { error: 'ls: ' + d + ': No such file or directory', code: 1 } : { text: list.join('\n') }; }
      case 'nslookup': {
        const q = cmd[1]; if (!q) return { error: 'nslookup: missing name', code: 1 };
        if (!NetPol.dnsAllowed(cluster, pod)) return { error: ';; connection timed out; no servers could be reached', code: 1 };
        const r = DNS.resolve(cluster, q, pod.metadata.namespace);
        if (!r) return { text: 'Server:\t\t10.96.0.10\nAddress:\t10.96.0.10:53\n', error: '** server can\'t find ' + q + ': NXDOMAIN', code: 1 };
        return { text: 'Server:\t\t10.96.0.10\nAddress:\t10.96.0.10:53\n\nName:\t' + (r.fqdn || q) + '\nAddress: ' + r.ip };
      }
      case 'wget': case 'curl': {
        const url = cmd.filter(a => !a.startsWith('-'))[1];
        if (!url) return { error: name + ': missing URL', code: 1 };
        const m = url.match(/^(?:https?:\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/);
        if (!m) return { error: name + ': bad address \'' + url + '\'', code: 1 };
        const host = m[1], port = parseInt(m[2] || '80', 10);
        const r = DNS.resolve(cluster, host, pod.metadata.namespace);
        if (!r) return { error: name === 'wget' ? 'wget: bad address \'' + host + '\'' : 'curl: (6) Could not resolve host: ' + host, code: name === 'wget' ? 1 : 6 };
        let targetPod, targetPort = port;
        if (r.service) {
          const sp = (r.service.spec.ports || []).find(p => p.port === port);
          if (!sp) return { error: name === 'wget' ? 'wget: can\'t connect to remote host (' + r.ip + '): Connection refused' : 'curl: (7) Failed to connect to ' + host + ' port ' + port + ' after 3 ms: Connection refused', code: name === 'wget' ? 1 : 7 };
          const ep = Printers.endpointsFor(cluster, r.service);
          if (!ep.subsets.length) return { error: name === 'wget' ? 'wget: can\'t connect to remote host (' + r.ip + '): Connection refused' : 'curl: (7) Failed to connect to ' + host + ' port ' + port + ': Connection refused', code: name === 'wget' ? 1 : 7 };
          targetPod = cluster.list(cluster.kinds.resolve('pod'), r.service.metadata.namespace).find(p => p.metadata.uid === ep.subsets[0].addresses[0].targetRef.uid);
          targetPort = ep.subsets[0].ports[0].port;
        } else targetPod = r.pod;
        const verdict = NetPol.allowed(cluster, pod, targetPod, targetPort);
        if (!verdict.allowed) return { error: name === 'wget' ? 'wget: download timed out' : 'curl: (28) Connection timed out after 5001 milliseconds', code: name === 'wget' ? 1 : 28 };
        const tc = targetPod.spec.containers[0];
        if (!(tc.ports || []).some(p => p.containerPort === targetPort) && !/nginx|httpd|echo|hello|podinfo|whoami/.test(tc.image) && !(r.service)) return { error: name + ': connection refused', code: 1 };
        if (/nginx/.test(tc.image)) return { text: '<!DOCTYPE html>\n<html>\n<head>\n<title>Welcome to nginx!</title>\n</head>\n<body>\n<h1>Welcome to nginx!</h1>\n<p>If you see this page, the nginx web server is successfully installed and\nworking. Further configuration is required.</p>\n</body>\n</html>' };
        if (/httpd/.test(tc.image)) return { text: '<html><body><h1>It works!</h1></body></html>' };
        return { text: 'Hello from ' + targetPod.metadata.name + ' (' + tc.image + ')' };
      }
      case 'nc': case 'netcat': return { text: '' };
      case 'df': return { text: 'Filesystem           1K-blocks      Used Available Use% Mounted on\noverlay               41152812  12345678  28807134  30% /\ntmpfs                    65536         0     65536   0% /dev' };
      case 'date': return { text: new Date().toUTCString() };
      case 'uname': return { text: cmd.includes('-a') ? 'Linux ' + pod.metadata.name + ' 5.15.0-119-generic #129-Ubuntu SMP x86_64 GNU/Linux' : 'Linux' };
      case 'mount': return { text: 'overlay on / type overlay (rw,relatime)\n' + (c.volumeMounts || []).map(m => 'tmpfs on ' + m.mountPath + ' type tmpfs (' + (m.readOnly ? 'ro' : 'rw') + ')').join('\n') };
      case 'nginx': return cmd[1] === '-v' || cmd[1] === '-V' ? { text: 'nginx version: nginx/' + (c.image.match(/:(\d+\.\d+(?:\.\d+)?)/) || [, '1.27.0'])[1] } : { text: '' };
      default:
        return { error: 'OCI runtime exec failed: exec failed: unable to start container process: exec: "' + name + '": executable file not found in $PATH: unknown', code: 126 };
    }
  }

  podEnv(cluster, pod, c) {
    const env = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOSTNAME: pod.metadata.name, HOME: '/root', KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT: '443', KUBERNETES_PORT: 'tcp://10.96.0.1:443' };
    if (/nginx/.test(c.image)) Object.assign(env, { NGINX_VERSION: (c.image.match(/:(\d+\.\d+(?:\.\d+)?)/) || [, '1.27.0'])[1], PKG_RELEASE: '1~bookworm', NJS_VERSION: '0.8.4' });
    for (const ef of c.envFrom || []) {
      const src = ef.configMapRef ? cluster.getByKindName('ConfigMap', pod.metadata.namespace, ef.configMapRef.name) : ef.secretRef ? cluster.getByKindName('Secret', pod.metadata.namespace, ef.secretRef.name) : null;
      if (src) for (const [k, v] of Object.entries(src.data || {})) env[(ef.prefix || '') + k] = ef.secretRef ? atob(v) : v;
    }
    for (const e of c.env || []) {
      if (e.value !== undefined) env[e.name] = String(e.value);
      else if (e.valueFrom) {
        const vf = e.valueFrom;
        if (vf.configMapKeyRef) { const cm = cluster.getByKindName('ConfigMap', pod.metadata.namespace, vf.configMapKeyRef.name); env[e.name] = cm && cm.data ? cm.data[vf.configMapKeyRef.key] : ''; }
        else if (vf.secretKeyRef) { const s = cluster.getByKindName('Secret', pod.metadata.namespace, vf.secretKeyRef.name); env[e.name] = s && s.data && s.data[vf.secretKeyRef.key] ? atob(s.data[vf.secretKeyRef.key]) : ''; }
        else if (vf.fieldRef) env[e.name] = String(getPath(pod, vf.fieldRef.fieldPath) || '');
      }
    }
    return env;
  }

  podFile(cluster, pod, c, path) {
    if (path === '/etc/hostname') return pod.metadata.name + '\n';
    if (path === '/etc/resolv.conf') return 'search ' + pod.metadata.namespace + '.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.96.0.10\noptions ndots:5\n';
    if (path === '/etc/hosts') return '127.0.0.1\tlocalhost\n' + (pod.status && pod.status.podIP) + '\t' + pod.metadata.name + '\n';
    if (path === '/var/run/secrets/kubernetes.io/serviceaccount/namespace') return pod.metadata.namespace;
    if (path === '/var/run/secrets/kubernetes.io/serviceaccount/token') return 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ii' + shortHash(pod.metadata.uid, 60) + '.' + shortHash(pod.metadata.name, 80);
    for (const m of c.volumeMounts || []) {
      if (!path.startsWith(m.mountPath.replace(/\/$/, '') + '/') && path !== m.mountPath) continue;
      const vol = (pod.spec.volumes || []).find(v => v.name === m.name);
      if (!vol) continue;
      const rel = path.slice(m.mountPath.replace(/\/$/, '').length + 1);
      const key = m.subPath || rel;
      if (vol.configMap) { const cm = cluster.getByKindName('ConfigMap', pod.metadata.namespace, vol.configMap.name); if (!cm) return null; const items = vol.configMap.items; const k = items ? (items.find(i => i.path === key) || {}).key : key; return cm.data && cm.data[k] !== undefined ? cm.data[k] : null; }
      if (vol.secret) { const s = cluster.getByKindName('Secret', pod.metadata.namespace, vol.secret.secretName); if (!s) return null; return s.data && s.data[key] !== undefined ? atob(s.data[key]) : null; }
      if (vol.persistentVolumeClaim || vol.emptyDir || vol.hostPath) { const st = cluster.simState(pod); const files = (st.files = st.files || {}); return files[path] !== undefined ? files[path] : null; }
    }
    if (/nginx/.test(c.image) && path === '/usr/share/nginx/html/index.html') return '<!DOCTYPE html>\n<html>\n<head>\n<title>Welcome to nginx!</title>\n</head>\n<body>\n<h1>Welcome to nginx!</h1>\n</body>\n</html>\n';
    if (/nginx/.test(c.image) && path === '/etc/nginx/nginx.conf') return 'user  nginx;\nworker_processes  auto;\nerror_log  /var/log/nginx/error.log notice;\npid        /var/run/nginx.pid;\nevents {\n    worker_connections  1024;\n}\nhttp {\n    include       /etc/nginx/mime.types;\n    default_type  application/octet-stream;\n    include /etc/nginx/conf.d/*.conf;\n}\n';
    return null;
  }

  podLs(cluster, pod, c, dir) {
    const d = dir.replace(/\/$/, '') || '/';
    if (d === '/') return ['bin', 'dev', 'etc', 'home', 'lib', 'proc', 'root', 'run', 'sbin', 'sys', 'tmp', 'usr', 'var'].concat((c.volumeMounts || []).map(m => m.mountPath.split('/')[1]).filter(x => x && !['etc', 'var', 'usr', 'tmp'].includes(x)));
    for (const m of c.volumeMounts || []) {
      if (m.mountPath.replace(/\/$/, '') !== d) continue;
      const vol = (pod.spec.volumes || []).find(v => v.name === m.name);
      if (vol && vol.configMap) { const cm = cluster.getByKindName('ConfigMap', pod.metadata.namespace, vol.configMap.name); return cm ? Object.keys(cm.data || {}) : []; }
      if (vol && vol.secret) { const s = cluster.getByKindName('Secret', pod.metadata.namespace, vol.secret.secretName); return s ? Object.keys(s.data || {}) : []; }
      return [];
    }
    if (d === '/etc') return ['hostname', 'hosts', 'resolv.conf', 'passwd', 'group'].concat(/nginx/.test(c.image) ? ['nginx'] : []);
    if (d === '/var/run/secrets/kubernetes.io/serviceaccount') return ['ca.crt', 'namespace', 'token'];
    if (d === '/usr/share/nginx/html' && /nginx/.test(c.image)) return ['50x.html', 'index.html'];
    return null;
  }

  cmd_top(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags);
    if (!t.cluster.getByKindName('Deployment', 'kube-system', 'metrics-server')) throw new KubectlError('Metrics API not available');
    const what = positional[0];
    if (what === 'node' || what === 'nodes' || what === 'no') {
      let nodes = t.cluster.nodes();
      if (positional[1]) { nodes = nodes.filter(n => n.metadata.name === positional[1]); if (!nodes.length) throw new ApiError('NotFound', 'nodes "' + positional[1] + '" not found'); }
      if (flags.selector) nodes = nodes.filter(n => labelsMatch(parseLabelSelector(flags.selector), n.metadata.labels));
      return io.out(Printers.topNodes(t.cluster, nodes, { sortBy: flags['sort-by'] }));
    }
    if (what === 'pod' || what === 'pods' || what === 'po') {
      let pods = this.listObjs(t, t.cluster.kinds.resolve('pod'), { selector: flags.selector ? parseLabelSelector(flags.selector) : null, names: positional[1] ? [positional[1]] : [] });
      pods = pods.filter(p => Printers.podInfo(t.cluster, p).phase === 'Running');
      if (!pods.length) return io.out(t.allNs ? 'No resources found' : 'No resources found in ' + t.ns + ' namespace.');
      return io.out(Printers.topPods(t.cluster, pods, { allNamespaces: t.allNs, sortBy: flags['sort-by'] }));
    }
    throw new KubectlError('unknown command "' + what + '" for "kubectl top" (node, pod)');
  }

  /* ---------- config / edit / explain / misc ---------- */
  cmd_config(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags, { needApi: false });
    const kc = t.kc;
    const sub = positional[0];
    if (sub === 'get-contexts') {
      const rows = Object.entries(kc.contexts).sort().map(([name, c]) => [name === kc.current ? '*' : '', name, c.cluster, c.user || 'kubernetes-admin', c.namespace || '']);
      return io.out(Printers.table(['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], rows));
    }
    if (sub === 'current-context') return io.out(kc.current);
    if (sub === 'use-context') {
      const name = positional[1];
      if (!name) throw new KubectlError('you must specify a context name');
      if (!kc.contexts[name]) throw new KubectlError('no context exists with the name: "' + name + '"');
      kc.current = name;
      return io.out('Switched to context "' + name + '".');
    }
    if (sub === 'set-context') {
      const name = flags.current ? kc.current : positional[1];
      if (!name || !kc.contexts[name]) throw new KubectlError('no context exists with the name: "' + name + '"');
      if (flags.namespace) kc.contexts[name].namespace = flags.namespace;
      if (flags.cluster) kc.contexts[name].cluster = flags.cluster;
      if (flags.user) kc.contexts[name].user = flags.user;
      return io.out('Context "' + name + '" modified.');
    }
    if (sub === 'get-clusters') return io.out('NAME\n' + Object.keys(kc.clusters || {}).join('\n'));
    if (sub === 'get-users') return io.out('NAME\n' + [...new Set(Object.values(kc.contexts).map(c => c.user || 'kubernetes-admin'))].join('\n'));
    if (sub === 'view') return io.out(YAML.stringify({
      apiVersion: 'v1', kind: 'Config', preferences: {}, 'current-context': kc.current,
      clusters: Object.entries(kc.clusters || {}).map(([name, c]) => ({ name, cluster: { 'certificate-authority-data': 'DATA+OMITTED', server: c.server } })),
      contexts: Object.entries(kc.contexts).map(([name, c]) => ({ name, context: Object.assign({ cluster: c.cluster, user: c.user || 'kubernetes-admin' }, c.namespace ? { namespace: c.namespace } : {}) })),
      users: [...new Set(Object.values(kc.contexts).map(c => c.user || 'kubernetes-admin'))].map(name => ({ name, user: { 'client-certificate-data': 'DATA+OMITTED', 'client-key-data': 'DATA+OMITTED' } })),
    }).replace(/\n$/, ''));
    if (sub === 'delete-context') { const n = positional[1]; if (!kc.contexts[n]) throw new KubectlError('cannot delete context ' + n + ', not in kubeconfig'); delete kc.contexts[n]; return io.out('deleted context ' + n + ' from kubeconfig'); }
    if (sub === 'rename-context') { const [a, b] = positional.slice(1); if (!kc.contexts[a]) throw new KubectlError('cannot rename the context "' + a + '", it\'s not in your kubeconfig'); kc.contexts[b] = kc.contexts[a]; delete kc.contexts[a]; if (kc.current === a) kc.current = b; return io.out('Context "' + a + '" renamed to "' + b + '".'); }
    throw new KubectlError('unknown command "' + sub + '" for "kubectl config"');
  }

  async cmd_edit(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags);
    this._cluster = t.cluster;
    const groups = this.parseResources(t.cluster, positional);
    if (groups.length !== 1 || groups[0].names.length !== 1) throw new KubectlError('edit exactly one resource at a time');
    const entry = groups[0].entry;
    const obj = this.listObjs(t, entry, { names: groups[0].names })[0];
    const original = '# Please edit the object below. Lines beginning with a \'#\' will be ignored,\n# and an empty file will abort the edit. If an error occurs while saving this file will be\n# reopened with the relevant failures.\n#\n' + YAML.stringify(obj);
    const resName = entry.plural + (entry.group ? '.' + entry.group : '') + ' "' + obj.metadata.name + '"';
    const res = await ctx.app.editor.open({ text: original, name: '/tmp/kubectl-edit-' + randSuffix(8) + '.yaml', onInvalid: (err) => {
      const msg = String(err).replace(/^error: /, '');
      if (/^error parsing YAML/.test(msg)) return ['# The edited file had a syntax error: ' + msg.replace(/^error parsing YAML: /, ''), '#'];
      return ['# ' + resName + ' was not valid:', '# * ' + msg, '#'];
    }, validate: (text) => {
      let doc;
      try { doc = YAML.parse(text); } catch (e) { return 'error: error parsing YAML: ' + e.message; }
      if (!doc) return null;
      if (doc.kind !== obj.kind || doc.metadata.name !== obj.metadata.name) return 'error: the kind or name of the object cannot be changed';
      try { t.cluster.validate(deepClone(doc), entry); } catch (e) { return String(e.message); }
      return null;
    } });
    if (!res.saved) return io.out(res.hadErrors ? 'Edit cancelled, no valid changes were saved.' : 'Edit cancelled, no changes made.');
    const doc = YAML.parse(res.text);
    if (!doc) return io.out('Edit cancelled, no changes made.');
    // YAML.stringify sorts keys, so this comparison ignores key order (the buffer is re-serialized).
    if (YAML.stringify(t.cluster.stripVolatile(doc)) === YAML.stringify(t.cluster.stripVolatile(obj))) return io.out('Edit cancelled, no changes made.');
    delete doc.status;
    t.cluster.update(doc);
    Sim.reconcile(t.cluster);
    io.out(t.cluster.kinds.fullName(entry, obj.metadata.name) + ' edited');
  }

  cmd_explain(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags);
    const q = (positional[0] || '').toLowerCase();
    if (!q) throw new KubectlError('You must specify the type of resource to explain. Use "kubectl api-resources" for a complete list of supported resources.');
    const [k, ...path] = q.split('.');
    const entry = t.cluster.kinds.resolve(k);
    if (!entry) throw new KubectlError('the server doesn\'t have a resource type "' + k + '"');
    const key = [entry.singular, ...path].join('.');
    if (EXPLAIN_DOCS[key]) return io.out(EXPLAIN_DOCS[key].replace(/\t/g, '\t'));
    if (!path.length) return io.out('KIND:       ' + entry.kind + '\nVERSION:    ' + entry.apiVersion + '\n\nDESCRIPTION:\n    ' + entry.kind + ' resource.\n\nFIELDS:\n  apiVersion\t<string>\n  kind\t<string>\n  metadata\t<ObjectMeta>\n  spec\t<' + entry.kind + 'Spec>\n  status\t<' + entry.kind + 'Status>');
    io.out('FIELD: ' + path[path.length - 1] + '\n\n(detailed schema for ' + key + ' is not included in this simulator; see kubernetes.io/docs/reference)');
  }

  cmd_api_resources(ctx, { flags }, io) {
    const t = this.target(ctx, flags);
    const namespaced = flags.namespaced === undefined ? undefined : flags.namespaced === true || flags.namespaced === 'true';
    io.out(Printers.apiResources(t.cluster, { namespaced }));
  }
  cmd_api_versions(ctx, { flags }, io) {
    const t = this.target(ctx, flags);
    io.out([...new Set(t.cluster.kinds.list().map(k => k.apiVersion))].sort().join('\n'));
  }
  cmd_version(ctx, { flags }, io) {
    const host = ctx.session.host;
    const v = (host.packages && host.packages.kubectl || this.app.world.clientVersion || '1.31.0').split('-')[0];
    io.out('Client Version: v' + v + '\nKustomize Version: v5.4.2');
    if (flags.client) return;
    try { const t = this.target(ctx, flags); io.out('Server Version: v' + t.cluster.version); }
    catch (e) { io.err(e instanceof RawError ? e.message : 'error: ' + e.message); }
  }
  cmd_cluster_info(ctx, { flags }, io) {
    const t = this.target(ctx, flags);
    const server = (t.kc.clusters && t.kc.clusters[t.cluster.name] || {}).server || 'https://127.0.0.1:6443';
    io.out('Kubernetes control plane is running at ' + server + '\nCoreDNS is running at ' + server + '/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy\n\nTo further debug and diagnose cluster problems, use \'kubectl cluster-info dump\'.');
  }

  cmd_auth(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags);
    if (positional[0] !== 'can-i') throw new KubectlError('unknown command "' + positional[0] + '" for "kubectl auth" (can-i)');
    const verb = positional[1]; const resArg = positional[2];
    if (!verb || !resArg) throw new KubectlError('you must specify two or three arguments: verb, resource, and optional resourceName');
    const [res, name] = resArg.split('/');
    const entry = t.cluster.kinds.resolve(res);
    const plural = entry ? entry.plural : res;
    let who = t.who;
    if (flags.as) {
      const m = flags.as.match(/^system:serviceaccount:([^:]+):(.+)$/);
      who = m ? { user: flags.as, groups: ['system:serviceaccounts', 'system:serviceaccounts:' + m[1], 'system:authenticated'], sa: m[1] + ':' + m[2] } : { user: flags.as, groups: (flags['as-group'] || []).concat(['system:authenticated']) };
    }
    const ok = Rbac.canI(t.cluster, who, verb, plural, entry && !entry.namespaced ? null : t.ns, name);
    io.out(ok ? 'yes' : 'no');
    if (!ok) throw new RawError('');
  }

  cmd_patch(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags);
    this._cluster = t.cluster; this._ctxSession = ctx.session;
    if (flags.patch === undefined) throw new KubectlError('must specify -p to patch');
    const targets = this.workloadTargets(t, flags, positional);
    let patch;
    try { patch = /^\s*[\[{]/.test(flags.patch) ? JSON.parse(flags.patch) : YAML.parse(flags.patch); } catch (e) { throw new KubectlError('unable to parse "' + flags.patch + '": ' + e.message); }
    for (const { entry, obj } of targets) {
      let next;
      if (flags.type === 'json') {
        next = deepClone(obj);
        for (const op of patch) {
          const keys = op.path.split('/').slice(1).map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
          let cur = next;
          for (let i = 0; i < keys.length - 1; i++) { if (cur[keys[i]] === undefined) cur[keys[i]] = /^\d+$/.test(keys[i + 1]) ? [] : {}; cur = cur[keys[i]]; }
          const last = keys[keys.length - 1];
          if (op.op === 'add' || op.op === 'replace') { if (Array.isArray(cur) && last === '-') cur.push(op.value); else if (Array.isArray(cur) && op.op === 'add') cur.splice(parseInt(last, 10), 0, op.value); else cur[last] = op.value; }
          else if (op.op === 'remove') { if (Array.isArray(cur)) cur.splice(parseInt(last, 10), 1); else delete cur[last]; }
          else throw new KubectlError('unsupported json patch op ' + op.op);
        }
      } else next = flags.type === 'merge' ? deepMerge(obj, patch) : strategicMerge(obj, patch);
      const before = JSON.stringify(t.cluster.stripVolatile(obj));
      const updated = t.cluster.update(next);
      Sim.reconcile(t.cluster);
      const changed = JSON.stringify(t.cluster.stripVolatile(updated)) !== before;
      io.out(t.cluster.kinds.fullName(entry, obj.metadata.name) + ' patched' + (changed ? '' : ' (no change)'));
    }
  }

  async cmd_wait(ctx, { flags, positional }, io) {
    const t = this.target(ctx, flags);
    const cond = flags.for;
    if (!cond) throw new KubectlError('required flag(s) "for" not set');
    const timeout = flags.timeout ? parseInt(flags.timeout, 10) * 1000 : 30000;
    const groups = this.parseResources(t.cluster, positional);
    const deadline = Date.now() + Math.min(timeout, 60000);
    for (const g of groups) {
      const names = g.names.length ? g.names : this.listObjs(t, g.entry, { selector: flags.selector ? parseLabelSelector(flags.selector) : null }).map(o => o.metadata.name);
      for (const n of names) {
        while (true) {
          Sim.reconcile(t.cluster);
          const obj = t.cluster.get(g.entry, t.ns, n);
          let met = false;
          if (cond === 'delete') met = !obj;
          else if (!obj) throw new ApiError('NotFound', g.entry.plural + ' "' + n + '" not found');
          else if (cond.startsWith('condition=')) {
            const [type, want] = cond.slice(10).split('=');
            const c = (obj.status && obj.status.conditions || []).find(x => x.type.toLowerCase() === type.toLowerCase());
            met = !!c && c.status.toLowerCase() === (want || 'true').toLowerCase();
          } else if (cond.startsWith('jsonpath=')) {
            const m = cond.slice(9).match(/^'?([^=]+?)'?=(.+)$/);
            if (!m) throw new KubectlError('jsonpath wait expression must be jsonpath={path}=value');
            met = Printers.jpEval(m[1].replace(/^\{|\}$/g, ''), obj).map(String).includes(m[2].replace(/^["']|["']$/g, ''));
          } else throw new KubectlError('unrecognized condition: "' + cond + '"');
          if (met) { io.out(t.cluster.kinds.fullName(g.entry, n) + ' condition met'); break; }
          if (Date.now() > deadline) throw new KubectlError('timed out waiting for the condition on ' + g.entry.plural + '/' + n);
          await new Promise(r => setTimeout(r, 600));
        }
      }
    }
  }

  cmd_completion(ctx, parsed, io) { io.out('# completion is preconfigured in this environment (alias k=kubectl, tab completion active)'); }
}
