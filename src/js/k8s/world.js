/* k8s/world.js — builds the whole exam world from a spec: one network,
   a base host with kubeconfig contexts, and per cluster the Cluster object,
   Node objects, node Hosts (kubelet/containerd services, packages, PKI,
   static pod manifests, kubeconfigs) and the system workloads a kubeadm
   cluster has. Seeded resources from the spec come last. */

const PEM = (label, seed) => '-----BEGIN ' + label + '-----\n' + (shortHash(seed, 64) + shortHash(seed + '2', 64) + shortHash(seed + '3', 64)).match(/.{1,64}/g).join('\n') + '\n-----END ' + label + '-----\n';

function kubeconfigText(name, server, user) {
  return YAML.stringify({
    apiVersion: 'v1', kind: 'Config', preferences: {}, 'current-context': user + '@' + name,
    clusters: [{ name, cluster: { 'certificate-authority-data': btoa(PEM('CERTIFICATE', name + 'ca')).slice(0, 120) + '...', server } }],
    contexts: [{ name: user + '@' + name, context: { cluster: name, user } }],
    users: [{ name: user, user: { 'client-certificate-data': btoa(PEM('CERTIFICATE', user)).slice(0, 120) + '...', 'client-key-data': btoa(PEM('RSA PRIVATE KEY', user)).slice(0, 120) + '...' } }],
  });
}

function staticPodManifest(component, { ip, version, etcdVersion }) {
  const flags = {
    'kube-apiserver': ['--advertise-address=' + ip, '--allow-privileged=true', '--authorization-mode=Node,RBAC', '--client-ca-file=/etc/kubernetes/pki/ca.crt', '--enable-admission-plugins=NodeRestriction', '--enable-bootstrap-token-auth=true', '--etcd-cafile=/etc/kubernetes/pki/etcd/ca.crt', '--etcd-certfile=/etc/kubernetes/pki/apiserver-etcd-client.crt', '--etcd-keyfile=/etc/kubernetes/pki/apiserver-etcd-client.key', '--etcd-servers=https://127.0.0.1:2379', '--kubelet-client-certificate=/etc/kubernetes/pki/apiserver-kubelet-client.crt', '--kubelet-client-key=/etc/kubernetes/pki/apiserver-kubelet-client.key', '--kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname', '--proxy-client-cert-file=/etc/kubernetes/pki/front-proxy-client.crt', '--proxy-client-key-file=/etc/kubernetes/pki/front-proxy-client.key', '--requestheader-allowed-names=front-proxy-client', '--requestheader-client-ca-file=/etc/kubernetes/pki/front-proxy-ca.crt', '--requestheader-extra-headers-prefix=X-Remote-Extra-', '--requestheader-group-headers=X-Remote-Group', '--requestheader-username-headers=X-Remote-User', '--secure-port=6443', '--service-account-issuer=https://kubernetes.default.svc.cluster.local', '--service-account-key-file=/etc/kubernetes/pki/sa.pub', '--service-account-signing-key-file=/etc/kubernetes/pki/sa.key', '--service-cluster-ip-range=10.96.0.0/12', '--tls-cert-file=/etc/kubernetes/pki/apiserver.crt', '--tls-private-key-file=/etc/kubernetes/pki/apiserver.key'],
    'etcd': ['--advertise-client-urls=https://' + ip + ':2379', '--cert-file=/etc/kubernetes/pki/etcd/server.crt', '--client-cert-auth=true', '--data-dir=/var/lib/etcd', '--experimental-initial-corrupt-check=true', '--experimental-watch-progress-notify-interval=5s', '--initial-advertise-peer-urls=https://' + ip + ':2380', '--initial-cluster=control=https://' + ip + ':2380', '--key-file=/etc/kubernetes/pki/etcd/server.key', '--listen-client-urls=https://127.0.0.1:2379,https://' + ip + ':2379', '--listen-metrics-urls=http://127.0.0.1:2381', '--listen-peer-urls=https://' + ip + ':2380', '--name=control', '--peer-cert-file=/etc/kubernetes/pki/etcd/peer.crt', '--peer-client-cert-auth=true', '--peer-key-file=/etc/kubernetes/pki/etcd/peer.key', '--peer-trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt', '--snapshot-count=10000', '--trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt'],
    'kube-controller-manager': ['--allocate-node-cidrs=true', '--authentication-kubeconfig=/etc/kubernetes/controller-manager.conf', '--authorization-kubeconfig=/etc/kubernetes/controller-manager.conf', '--bind-address=127.0.0.1', '--client-ca-file=/etc/kubernetes/pki/ca.crt', '--cluster-cidr=10.244.0.0/16', '--cluster-name=kubernetes', '--cluster-signing-cert-file=/etc/kubernetes/pki/ca.crt', '--cluster-signing-key-file=/etc/kubernetes/pki/ca.key', '--controllers=*,bootstrapsigner,tokencleaner', '--kubeconfig=/etc/kubernetes/controller-manager.conf', '--leader-elect=true', '--requestheader-client-ca-file=/etc/kubernetes/pki/front-proxy-ca.crt', '--root-ca-file=/etc/kubernetes/pki/ca.crt', '--service-account-private-key-file=/etc/kubernetes/pki/sa.key', '--service-cluster-ip-range=10.96.0.0/12', '--use-service-account-credentials=true'],
    'kube-scheduler': ['--authentication-kubeconfig=/etc/kubernetes/scheduler.conf', '--authorization-kubeconfig=/etc/kubernetes/scheduler.conf', '--bind-address=127.0.0.1', '--kubeconfig=/etc/kubernetes/scheduler.conf', '--leader-elect=true'],
  }[component];
  const image = component === 'etcd' ? 'registry.k8s.io/etcd:' + etcdVersion : 'registry.k8s.io/' + component + ':v' + version;
  const mounts = {
    'kube-apiserver': [{ mountPath: '/etc/ssl/certs', name: 'ca-certs', readOnly: true }, { mountPath: '/etc/ca-certificates', name: 'etc-ca-certificates', readOnly: true }, { mountPath: '/etc/kubernetes/pki', name: 'k8s-certs', readOnly: true }],
    'etcd': [{ mountPath: '/var/lib/etcd', name: 'etcd-data' }, { mountPath: '/etc/kubernetes/pki/etcd', name: 'etcd-certs' }],
    'kube-controller-manager': [{ mountPath: '/etc/ssl/certs', name: 'ca-certs', readOnly: true }, { mountPath: '/etc/kubernetes/pki', name: 'k8s-certs', readOnly: true }, { mountPath: '/etc/kubernetes/controller-manager.conf', name: 'kubeconfig', readOnly: true }],
    'kube-scheduler': [{ mountPath: '/etc/kubernetes/scheduler.conf', name: 'kubeconfig', readOnly: true }],
  }[component];
  const volumes = mounts.map(m => ({ hostPath: { path: m.name === 'ca-certs' ? '/etc/ssl/certs' : m.name === 'etc-ca-certificates' ? '/etc/ca-certificates' : m.name === 'k8s-certs' ? '/etc/kubernetes/pki' : m.name === 'etcd-data' ? '/var/lib/etcd' : m.name === 'etcd-certs' ? '/etc/kubernetes/pki/etcd' : m.mountPath, type: m.name.includes('certs') && m.name !== 'etcd-certs' ? 'DirectoryOrCreate' : m.name === 'kubeconfig' ? 'FileOrCreate' : 'DirectoryOrCreate' }, name: m.name }));
  const port = { 'kube-apiserver': 6443, 'etcd': 2381, 'kube-controller-manager': 10257, 'kube-scheduler': 10259 }[component];
  const probe = { failureThreshold: 8, httpGet: { host: component === 'kube-apiserver' ? ip : '127.0.0.1', path: component === 'etcd' ? '/livez' : component === 'kube-apiserver' ? '/livez' : '/healthz', port, scheme: component === 'etcd' ? 'HTTP' : 'HTTPS' }, initialDelaySeconds: 10, periodSeconds: 10, timeoutSeconds: 15 };
  const obj = {
    apiVersion: 'v1', kind: 'Pod',
    metadata: Object.assign({ creationTimestamp: null, labels: { component, tier: 'control-plane' }, name: component, namespace: 'kube-system' },
      component === 'kube-apiserver' ? { annotations: { 'kubeadm.kubernetes.io/kube-apiserver.advertise-address.endpoint': ip + ':6443' } } : component === 'etcd' ? { annotations: { 'kubeadm.kubernetes.io/etcd.advertise-client-urls': 'https://' + ip + ':2379' } } : {}),
    spec: {
      containers: [{ command: [component, ...flags], image, imagePullPolicy: 'IfNotPresent', livenessProbe: probe, name: component, resources: { requests: component === 'etcd' ? { cpu: '100m', memory: '100Mi' } : { cpu: component === 'kube-apiserver' ? '250m' : '100m' } }, startupProbe: Object.assign({}, probe, { failureThreshold: 24 }), volumeMounts: mounts }],
      hostNetwork: true, priority: 2000001000, priorityClassName: 'system-node-critical', securityContext: { seccompProfile: { type: 'RuntimeDefault' } }, volumes,
    },
    status: {},
  };
  return { text: YAML.stringify(obj), flags: new Set(flags.map(f => f.split('=')[0])) };
}

const EXTRA_STATIC_FLAGS = {
  'kube-apiserver': ['--audit-log-path', '--audit-policy-file', '--audit-log-maxage', '--audit-log-maxbackup', '--audit-log-maxsize', '--feature-gates', '--v', '--admission-control-config-file', '--encryption-provider-config', '--tls-min-version', '--anonymous-auth', '--profiling', '--kubelet-certificate-authority', '--enable-admission-plugins', '--disable-admission-plugins', '--runtime-config', '--oidc-issuer-url', '--oidc-client-id', '--service-node-port-range', '--tls-cipher-suites', '--event-ttl'],
  'etcd': ['--auto-compaction-retention', '--quota-backend-bytes', '--log-level', '--election-timeout', '--heartbeat-interval'],
  'kube-controller-manager': ['--feature-gates', '--v', '--node-monitor-grace-period', '--pod-eviction-timeout', '--terminated-pod-gc-threshold', '--profiling', '--horizontal-pod-autoscaler-sync-period'],
  'kube-scheduler': ['--feature-gates', '--v', '--config', '--profiling'],
};

class World {
  constructor(spec) {
    this.spec = spec;
    this.network = new Network({ name: 'exam', cidr: '10.0.0.0/24' });
    this.hosts = new Map();
    this.clusters = new Map();
    this.candidate = spec.candidate || 'candidate';
    this.clientVersion = spec.clientVersion || '1.31.0';
    this.build();
  }

  addHost(host) { this.network.attach(host); this.hosts.set(host.hostname, host); return host; }
  lookup(target) {
    if (target === 'localhost' || target === '127.0.0.1') return null;
    return this.network.find(target);
  }

  build() {
    const spec = this.spec;
    const baseCfg = spec.base || {};
    const base = new Host({ hostname: baseCfg.hostname || 'cka-base', ip: baseCfg.ip || '10.0.0.5', role: 'base', latency: 1, homeFiles: baseCfg.homeFiles || {} });
    base.addUser(new User({ name: this.candidate }));
    base.addUser(new User({ name: 'root', admin: true }));
    base.packages = { kubectl: this.clientVersion + '-1.1', vim: '9.1', jq: '1.7', helm: '3.16.2' };
    this.base = this.addHost(base);

    const contexts = {};
    const clusters = {};
    for (const [name, cfg] of Object.entries(spec.clusters || {})) {
      const cluster = this.buildCluster(name, cfg);
      const cp = cluster.controlPlaneNodes()[0];
      const cpHost = cp && cluster.nodeHost(cp.metadata.name);
      clusters[name] = { server: 'https://' + (cpHost ? cpHost.ip : '127.0.0.1') + ':6443' };
    }
    for (const [ctxName, c] of Object.entries(spec.contexts || {})) contexts[ctxName] = { cluster: c.cluster, user: c.user || 'kubernetes-admin', namespace: c.namespace || 'default' };
    if (!Object.keys(contexts).length) for (const name of this.clusters.keys()) contexts[name] = { cluster: name, user: 'kubernetes-admin', namespace: 'default' };
    base.kubeconfig = { contexts, clusters, current: spec.defaultContext || Object.keys(contexts)[0] };
    const home = ['home', this.candidate];
    base.fs.mkdir(home.concat(['.kube']), null, { mode: 0o700 }).owner = this.candidate;
    base.seedFile('/home/' + this.candidate + '/.kube/config', YAML.stringify({
      apiVersion: 'v1', kind: 'Config', preferences: {}, 'current-context': base.kubeconfig.current,
      clusters: Object.entries(clusters).map(([name, c]) => ({ name, cluster: { 'certificate-authority-data': 'LS0tLS1CRUdJTi...', server: c.server } })),
      contexts: Object.entries(contexts).map(([name, c]) => ({ name, context: { cluster: c.cluster, user: c.user, namespace: c.namespace } })),
      users: [{ name: 'kubernetes-admin', user: { 'client-certificate-data': 'LS0tLS1CRUdJTi...', 'client-key-data': 'LS0tLS1CRUdJTi...' } }],
    }), { owner: this.candidate, mode: 0o600 });
    base.seedFile('/home/' + this.candidate + '/.bashrc', 'alias k=kubectl\ncomplete -o default -F __start_kubectl k\nexport do="--dry-run=client -o yaml"\nexport now="--force --grace-period 0"\n', { owner: this.candidate, mode: 0o644 });
    for (const [path, spec2] of Object.entries(baseCfg.files || {})) this.seedSpecFile(base, path, spec2);
    for (const [name, svc] of Object.entries(baseCfg.services || {})) base.addService(name, svc);

    // /etc/hosts everywhere
    let hostsText = '127.0.0.1\tlocalhost\n';
    for (const h of this.hosts.values()) hostsText += h.ip + '\t' + h.hostname + '\n';
    for (const h of this.hosts.values()) h.fs.writeFile(['etc', 'hosts'], hostsText, null);
  }

  seedSpecFile(host, path, spec) {
    if (spec === null || path.endsWith('/') || (spec && typeof spec === 'object' && spec.dir)) {
      host.seedDir(path.replace(/\/+$/, ''), { owner: spec && spec.owner || 'root', mode: spec && spec.mode !== undefined ? parseInt(String(spec.mode), 8) : 0o755 });
      return;
    }
    let content = typeof spec === 'string' ? spec : String((spec && spec.content) || '');
    content = content.replace(/\{\{sha256:([^}]*)\}\}/g, (m, t) => sha256Like(t.replace(/\\n/g, '\n')));
    content = content.replace(/\{\{pem:([^:}]+):([^}]*)\}\}/g, (m, label, seed) => PEM(label.trim(), seed.trim()));
    host.seedFile(path, content === '' || content.endsWith('\n') ? content : content + '\n', { owner: spec && typeof spec === 'object' && spec.owner || 'root', mode: spec && typeof spec === 'object' && spec.mode !== undefined ? parseInt(String(spec.mode), 8) : 0o644 });
  }

  buildCluster(name, cfg) {
    const version = cfg.version || '1.31.0';
    const cluster = new Cluster({ name, version });
    cluster.badImages = cfg.badImages || [];
    cluster.upgradeVersions = cfg.upgradeVersions || [];
    const ageDays = cfg.ageDays || 30;
    const t0 = Date.now() - ageDays * 86400e3;
    const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
    this.clusters.set(name, cluster);

    for (const ns of ['default', 'kube-node-lease', 'kube-public', 'kube-system']) {
      cluster.create({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels: { 'kubernetes.io/metadata.name': ns }, creationTimestamp: iso(t0) } });
    }
    cluster.create({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'kubernetes', namespace: 'default', labels: { component: 'apiserver', provider: 'kubernetes' }, creationTimestamp: iso(t0) }, spec: { clusterIP: '10.96.0.1', ports: [{ name: 'https', port: 443, protocol: 'TCP', targetPort: 6443 }], type: 'ClusterIP' } });
    for (const pc of [['system-cluster-critical', 2000000000, 'Used for system critical pods that must run in the cluster, but can be moved to another node if necessary.'], ['system-node-critical', 2000001000, 'Used for system critical pods that must not be moved from their current node.']]) {
      cluster.create({ apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: { name: pc[0], creationTimestamp: iso(t0) }, value: pc[1], globalDefault: false, description: pc[2] });
    }
    for (const [crName, rules] of [['cluster-admin', [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }, { nonResourceURLs: ['*'], verbs: ['*'] }]], ['admin', [{ apiGroups: ['', 'apps', 'batch', 'networking.k8s.io'], resources: ['*'], verbs: ['*'] }]], ['edit', [{ apiGroups: ['', 'apps', 'batch'], resources: ['pods', 'deployments', 'services', 'configmaps', 'secrets', 'jobs', 'cronjobs', 'replicasets', 'daemonsets', 'statefulsets', 'persistentvolumeclaims', 'pods/log', 'pods/exec'], verbs: ['create', 'delete', 'deletecollection', 'patch', 'update', 'get', 'list', 'watch'] }]], ['view', [{ apiGroups: ['', 'apps', 'batch'], resources: ['pods', 'deployments', 'services', 'configmaps', 'jobs', 'cronjobs', 'replicasets', 'daemonsets', 'statefulsets', 'persistentvolumeclaims', 'pods/log'], verbs: ['get', 'list', 'watch'] }]], ['system:node', [{ apiGroups: [''], resources: ['nodes', 'pods'], verbs: ['*'] }]], ['system:kube-scheduler', [{ apiGroups: [''], resources: ['pods', 'nodes', 'bindings'], verbs: ['*'] }]]]) {
      cluster.create({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: crName, creationTimestamp: iso(t0), labels: { 'kubernetes.io/bootstrapping': 'rbac-defaults' } }, rules });
    }
    cluster.create({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name: 'cluster-admin', creationTimestamp: iso(t0), labels: { 'kubernetes.io/bootstrapping': 'rbac-defaults' } }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' }, subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'system:masters' }] });

    const nodes = cfg.nodes || [];
    const cpNodes = nodes.filter(n => (n.roles || []).includes('control-plane'));
    nodes.forEach((n, i) => {
      const isCP = (n.roles || []).includes('control-plane');
      const host = new Host({ hostname: n.name, ip: n.ip, role: isCP ? 'control-plane' : 'worker', latency: 2, up: n.up !== false });
      host.addUser(new User({ name: this.candidate }));
      host.addUser(new User({ name: 'root', admin: true }));
      const pkgVer = (n.version || version);
      host.packages = { kubeadm: pkgVer + '-1.1', kubelet: pkgVer + '-1.1', kubectl: pkgVer + '-1.1', containerd: '1.7.22-1', 'cri-tools': pkgVer.split('.').slice(0, 2).join('.') + '.0-1.1' };
      host.availablePackages = { kubeadm: [pkgVer, ...cluster.upgradeVersions].map(v => v + '-1.1'), kubelet: [pkgVer, ...cluster.upgradeVersions].map(v => v + '-1.1'), kubectl: [pkgVer, ...cluster.upgradeVersions].map(v => v + '-1.1') };
      host.heldPackages = new Set(['kubeadm', 'kubelet', 'kubectl']);
      host.runningKubeletVersion = pkgVer;
      host.addService('kubelet', { description: 'kubelet: The Kubernetes Node Agent', unitFile: '/usr/lib/systemd/system/kubelet.service', health: { file: '/var/lib/kubelet/config.yaml', mustContain: 'kind: KubeletConfiguration', message: 'failed to load kubelet config file, path: /var/lib/kubelet/config.yaml, error: failed to decode: no kind "KubeletConfiguration" is registered' } });
      host.addService('containerd', { description: 'containerd container runtime', unitFile: '/usr/lib/systemd/system/containerd.service' });
      this.seedNodeFiles(host, cluster, n, isCP, cpNodes[0] || n);
      if (isCP) host.kubeconfig = { contexts: { 'kubernetes-admin@kubernetes': { cluster: name, user: 'kubernetes-admin', namespace: 'default' } }, clusters: { [name]: { server: 'https://' + n.ip + ':6443' } }, current: 'kubernetes-admin@kubernetes' };
      this.addHost(host);
      cluster.bindNodeHost(n.name, host);

      const labels = Object.assign({ 'beta.kubernetes.io/arch': 'amd64', 'beta.kubernetes.io/os': 'linux', 'kubernetes.io/arch': 'amd64', 'kubernetes.io/hostname': n.name, 'kubernetes.io/os': 'linux' }, isCP ? { 'node-role.kubernetes.io/control-plane': '', 'node.kubernetes.io/exclude-from-external-load-balancers': '' } : {}, n.labels || {});
      const node = cluster.create({
        apiVersion: 'v1', kind: 'Node',
        metadata: { name: n.name, labels, annotations: { 'kubeadm.alpha.kubernetes.io/cri-socket': 'unix:///var/run/containerd/containerd.sock', 'node.alpha.kubernetes.io/ttl': '0', 'volumes.kubernetes.io/controller-managed-attach-detach': 'true', 'flannel.alpha.coreos.com/public-ip': n.ip, 'flannel.alpha.coreos.com/backend-type': 'vxlan' }, creationTimestamp: iso(t0 + i * 60000) },
        spec: Object.assign({ podCIDR: '10.244.' + i + '.0/24', podCIDRs: ['10.244.' + i + '.0/24'] }, isCP ? { taints: [{ effect: 'NoSchedule', key: 'node-role.kubernetes.io/control-plane' }] } : n.taints ? { taints: n.taints } : {}, n.unschedulable ? { unschedulable: true } : {}),
        status: { capacity: { cpu: String(n.cpu || 2), 'ephemeral-storage': '40593708Ki', 'hugepages-2Mi': '0', memory: n.memory || '4025432Ki', pods: '110' }, allocatable: { cpu: String(n.cpu || 2), 'ephemeral-storage': '37411072230', 'hugepages-2Mi': '0', memory: n.memory ? n.memory : '3923032Ki', pods: '110' }, addresses: [{ address: n.ip, type: 'InternalIP' }, { address: n.name, type: 'Hostname' }], daemonEndpoints: { kubeletEndpoint: { Port: 10250 } }, nodeInfo: { architecture: 'amd64', bootID: randomUid(), containerRuntimeVersion: 'containerd://1.7.22', kernelVersion: '5.15.0-119-generic', kubeProxyVersion: 'v' + pkgVer, kubeletVersion: 'v' + pkgVer, machineID: shortHash(n.name, 32), operatingSystem: 'linux', osImage: 'Ubuntu 22.04.4 LTS', systemUUID: randomUid() } },
      });
      cluster.nodeOrder.push(n.name);
      if (isCP) {
        for (const component of ['etcd', 'kube-apiserver', 'kube-controller-manager', 'kube-scheduler']) {
          const pod = cluster.create({
            apiVersion: 'v1', kind: 'Pod',
            metadata: { name: component + '-' + n.name, namespace: 'kube-system', labels: { component, tier: 'control-plane' }, annotations: { 'kubernetes.io/config.hash': shortHash(component + n.name, 32), 'kubernetes.io/config.mirror': shortHash(component + n.name, 32), 'kubernetes.io/config.seen': iso(t0), 'kubernetes.io/config.source': 'file' }, ownerReferences: [{ apiVersion: 'v1', kind: 'Node', name: n.name, uid: node.metadata.uid, controller: true }], creationTimestamp: iso(t0) },
            spec: { nodeName: n.name, hostNetwork: true, priorityClassName: 'system-node-critical', priority: 2000001000, containers: [{ name: component, image: component === 'etcd' ? 'registry.k8s.io/etcd:3.5.15-0' : 'registry.k8s.io/' + component + ':v' + version, command: YAML.parse(host.fs.readFile(['etc', 'kubernetes', 'manifests', component + '.yaml'], null)).spec.containers[0].command, resources: { requests: { cpu: component === 'kube-apiserver' ? '250m' : '100m' } } }] },
          }, { sim: { staticComponent: component, cpu: component === 'kube-apiserver' ? 45 : component === 'etcd' ? 20 : 8, memory: component === 'kube-apiserver' ? 260 : component === 'etcd' ? 60 : 40 } });
          pod.metadata.creationTimestamp = iso(t0);
        }
      }
    });

    // system workloads
    const sys = (obj, sim) => { obj.metadata.creationTimestamp = obj.metadata.creationTimestamp || iso(t0); return cluster.create(obj, { sim: sim || {} }); };
    const cpTolerations = [{ key: 'CriticalAddonsOnly', operator: 'Exists' }, { key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }];
    sys({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'coredns', namespace: 'kube-system' }, data: { Corefile: '.:53 {\n    errors\n    health {\n       lameduck 5s\n    }\n    ready\n    kubernetes cluster.local in-addr.arpa ip6.arpa {\n       pods insecure\n       fallthrough in-addr.arpa ip6.arpa\n       ttl 30\n    }\n    prometheus :9153\n    forward . /etc/resolv.conf {\n       max_concurrent 1000\n    }\n    cache 30\n    loop\n    reload\n    loadbalance\n}\n' } });
    sys({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'kubeadm-config', namespace: 'kube-system' }, data: { ClusterConfiguration: 'apiServer:\n  extraArgs:\n    authorization-mode: Node,RBAC\napiVersion: kubeadm.k8s.io/v1beta3\ncertificatesDir: /etc/kubernetes/pki\nclusterName: kubernetes\ncontrollerManager: {}\ndns: {}\netcd:\n  local:\n    dataDir: /var/lib/etcd\nimageRepository: registry.k8s.io\nkind: ClusterConfiguration\nkubernetesVersion: v' + version + '\nnetworking:\n  dnsDomain: cluster.local\n  podSubnet: 10.244.0.0/16\n  serviceSubnet: 10.96.0.0/12\nscheduler: {}\n' } });
    sys({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'kubelet-config', namespace: 'kube-system' }, data: { kubelet: 'apiVersion: kubelet.config.k8s.io/v1beta1\nauthentication:\n  anonymous:\n    enabled: false\n  webhook:\n    enabled: true\nauthorization:\n  mode: Webhook\ncgroupDriver: systemd\nclusterDNS:\n- 10.96.0.10\nclusterDomain: cluster.local\nkind: KubeletConfiguration\nstaticPodPath: /etc/kubernetes/manifests\n' } });
    sys({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'kube-proxy', namespace: 'kube-system', labels: { app: 'kube-proxy' } }, data: { 'config.conf': 'apiVersion: kubeproxy.config.k8s.io/v1alpha1\nkind: KubeProxyConfiguration\nmode: iptables\nclusterCIDR: 10.244.0.0/16\n', 'kubeconfig.conf': 'apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    server: https://' + (cpNodes[0] ? cpNodes[0].ip : '127.0.0.1') + ':6443\n  name: default\n' } });
    sys({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'coredns', namespace: 'kube-system' } });
    sys({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'kube-proxy', namespace: 'kube-system' } });
    sys({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'kube-dns', namespace: 'kube-system', labels: { 'k8s-app': 'kube-dns', 'kubernetes.io/cluster-service': 'true', 'kubernetes.io/name': 'CoreDNS' }, annotations: { 'prometheus.io/port': '9153', 'prometheus.io/scrape': 'true' } }, spec: { clusterIP: '10.96.0.10', selector: { 'k8s-app': 'kube-dns' }, ports: [{ name: 'dns', port: 53, protocol: 'UDP', targetPort: 53 }, { name: 'dns-tcp', port: 53, protocol: 'TCP', targetPort: 53 }, { name: 'metrics', port: 9153, protocol: 'TCP', targetPort: 9153 }] } });
    sys({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'coredns', namespace: 'kube-system', labels: { 'k8s-app': 'kube-dns' } }, spec: { replicas: 2, selector: { matchLabels: { 'k8s-app': 'kube-dns' } }, strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: 1 } }, template: { metadata: { labels: { 'k8s-app': 'kube-dns' } }, spec: { serviceAccountName: 'coredns', priorityClassName: 'system-cluster-critical', nodeSelector: { 'kubernetes.io/os': 'linux' }, tolerations: cpTolerations, containers: [{ name: 'coredns', image: 'registry.k8s.io/coredns/coredns:v1.11.3', args: ['-conf', '/etc/coredns/Corefile'], ports: [{ containerPort: 53, name: 'dns', protocol: 'UDP' }, { containerPort: 53, name: 'dns-tcp', protocol: 'TCP' }, { containerPort: 9153, name: 'metrics', protocol: 'TCP' }], resources: { limits: { memory: '170Mi' }, requests: { cpu: '100m', memory: '70Mi' } }, volumeMounts: [{ mountPath: '/etc/coredns', name: 'config-volume', readOnly: true }] }], volumes: [{ name: 'config-volume', configMap: { name: 'coredns', items: [{ key: 'Corefile', path: 'Corefile' }] } }] } } } });
    sys({ apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: 'kube-proxy', namespace: 'kube-system', labels: { 'k8s-app': 'kube-proxy' } }, spec: { selector: { matchLabels: { 'k8s-app': 'kube-proxy' } }, updateStrategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } }, template: { metadata: { labels: { 'k8s-app': 'kube-proxy' } }, spec: { serviceAccountName: 'kube-proxy', priorityClassName: 'system-node-critical', hostNetwork: true, nodeSelector: { 'kubernetes.io/os': 'linux' }, tolerations: [{ operator: 'Exists' }], containers: [{ name: 'kube-proxy', image: 'registry.k8s.io/kube-proxy:v' + version, command: ['/usr/local/bin/kube-proxy', '--config=/var/lib/kube-proxy/config.conf', '--hostname-override=$(NODE_NAME)'], env: [{ name: 'NODE_NAME', valueFrom: { fieldRef: { apiVersion: 'v1', fieldPath: 'spec.nodeName' } } }], securityContext: { privileged: true }, volumeMounts: [{ mountPath: '/var/lib/kube-proxy', name: 'kube-proxy' }, { mountPath: '/run/xtables.lock', name: 'xtables-lock' }, { mountPath: '/lib/modules', name: 'lib-modules', readOnly: true }] }], volumes: [{ name: 'kube-proxy', configMap: { name: 'kube-proxy' } }, { name: 'xtables-lock', hostPath: { path: '/run/xtables.lock', type: 'FileOrCreate' } }, { name: 'lib-modules', hostPath: { path: '/lib/modules' } }] } } } });
    sys({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'kube-flannel', labels: { 'kubernetes.io/metadata.name': 'kube-flannel', 'pod-security.kubernetes.io/enforce': 'privileged' } } });
    sys({ apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: 'kube-flannel-ds', namespace: 'kube-flannel', labels: { app: 'flannel', 'k8s-app': 'flannel', tier: 'node' } }, spec: { selector: { matchLabels: { app: 'flannel' } }, template: { metadata: { labels: { app: 'flannel', tier: 'node' } }, spec: { hostNetwork: true, priorityClassName: 'system-node-critical', tolerations: [{ operator: 'Exists', effect: 'NoSchedule' }], initContainers: [{ name: 'install-cni-plugin', image: 'docker.io/flannel/flannel-cni-plugin:v1.5.1-flannel2', command: ['cp'], args: ['-f', '/flannel', '/opt/cni/bin/flannel'], volumeMounts: [{ name: 'cni-plugin', mountPath: '/opt/cni/bin' }] }], containers: [{ name: 'kube-flannel', image: 'docker.io/flannel/flannel:v0.25.6', command: ['/opt/bin/flanneld'], args: ['--ip-masq', '--kube-subnet-mgr'], resources: { requests: { cpu: '100m', memory: '50Mi' } }, securityContext: { privileged: false, capabilities: { add: ['NET_ADMIN', 'NET_RAW'] } }, volumeMounts: [{ name: 'run', mountPath: '/run/flannel' }, { name: 'flannel-cfg', mountPath: '/etc/kube-flannel/' }] }], volumes: [{ name: 'run', hostPath: { path: '/run/flannel' } }, { name: 'cni-plugin', hostPath: { path: '/opt/cni/bin' } }, { name: 'flannel-cfg', configMap: { name: 'kube-flannel-cfg' } }] } } } });
    sys({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'kube-flannel-cfg', namespace: 'kube-flannel', labels: { app: 'flannel', tier: 'node' } }, data: { 'cni-conf.json': '{\n  "name": "cbr0",\n  "cniVersion": "0.3.1",\n  "plugins": [\n    {\n      "type": "flannel",\n      "delegate": {\n        "hairpinMode": true,\n        "isDefaultGateway": true\n      }\n    }\n  ]\n}\n', 'net-conf.json': '{\n  "Network": "10.244.0.0/16",\n  "Backend": {\n    "Type": "vxlan"\n  }\n}\n' } });
    sys({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'metrics-server', namespace: 'kube-system', labels: { 'k8s-app': 'metrics-server' } }, spec: { replicas: 1, selector: { matchLabels: { 'k8s-app': 'metrics-server' } }, strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: '25%' } }, template: { metadata: { labels: { 'k8s-app': 'metrics-server' } }, spec: { priorityClassName: 'system-cluster-critical', nodeSelector: { 'kubernetes.io/os': 'linux' }, containers: [{ name: 'metrics-server', image: 'registry.k8s.io/metrics-server/metrics-server:v0.7.2', args: ['--cert-dir=/tmp', '--secure-port=10250', '--kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname', '--kubelet-use-node-status-port', '--metric-resolution=15s', '--kubelet-insecure-tls'], ports: [{ containerPort: 10250, name: 'https', protocol: 'TCP' }], resources: { requests: { cpu: '100m', memory: '200Mi' } } }] } } } });

    // seeded resources
    for (const raw of cfg.resources || []) {
      const r = deepClone(raw);
      const sim = r._sim || {};
      const age = r._ageSeconds;
      const revisions = r._revisions;
      delete r._sim; delete r._ageSeconds; delete r._revisions;
      r.metadata = r.metadata || {};
      r.metadata.creationTimestamp = r.metadata.creationTimestamp || iso(age !== undefined ? Date.now() - age * 1000 : t0 + 3600e3);
      if (r.kind === 'Deployment' && Array.isArray(revisions) && revisions.length) {
        // _revisions: earlier rollouts, oldest first ({ image } or { template } plus an optional
        // change-cause). Each is rolled through the controller so `rollout history` and
        // `rollout undo` have real revisions behind them; the seeded spec is the latest one.
        const finalSpec = deepClone(r.spec), finalAnn = deepClone(r.metadata.annotations || {});
        const withRevision = (rev) => {
          const tpl = rev.template ? strategicMerge(deepClone(finalSpec.template), rev.template) : deepClone(finalSpec.template);
          if (rev.image) tpl.spec.containers[0].image = rev.image;
          return tpl;
        };
        r.spec.template = withRevision(revisions[0]);
        r.metadata.annotations = Object.assign({}, finalAnn, revisions[0].cause ? { 'kubernetes.io/change-cause': revisions[0].cause } : {});
        if (!revisions[0].cause) delete r.metadata.annotations['kubernetes.io/change-cause'];
        const d = cluster.create(r, { sim });
        Sim.reconcile(cluster);
        const steps = revisions.slice(1).map(rev => ({ template: withRevision(rev), cause: rev.cause })).concat([{ template: finalSpec.template, cause: finalAnn['kubernetes.io/change-cause'] }]);
        for (const step of steps) {
          const next = deepClone(d);
          next.spec.template = step.template;
          next.metadata.annotations = Object.assign({}, next.metadata.annotations || {});
          if (step.cause) next.metadata.annotations['kubernetes.io/change-cause'] = step.cause; else delete next.metadata.annotations['kubernetes.io/change-cause'];
          Object.assign(d, cluster.update(next));
          Sim.reconcile(cluster);
        }
        continue;
      }
      cluster.create(r, { sim });
    }

    // host overrides (troubleshooting setups)
    for (const [hn, hc] of Object.entries(cfg.hosts || {})) {
      const host = this.hosts.get(hn);
      if (!host) throw new ConfigError('cluster ' + name + ': host override for unknown node ' + hn);
      for (const [sname, sc] of Object.entries(hc.services || {})) {
        const svc = host.service(sname) || host.addService(sname, {});
        if (sc.active !== undefined) svc.active = !!sc.active;
        if (sc.enabled !== undefined) svc.enabled = !!sc.enabled;
        if (sc.description) svc.description = sc.description;
        if (sc.health !== undefined) svc.health = sc.health;
        if (sc.journal) for (const line of sc.journal) svc.log(line);
      }
      for (const [path, spec2] of Object.entries(hc.files || {})) this.seedSpecFile(host, path, spec2);
      for (const [path] of Object.entries(hc.deleteFiles ? Object.fromEntries(hc.deleteFiles.map(p => [p, true])) : {})) { try { host.fs.remove(path.split('/').filter(Boolean), null, { recursive: true }); } catch (e) { /* ignore */ } }
      for (const [component, edit] of Object.entries(hc.editManifests || {})) {
        const parts = ['etc', 'kubernetes', 'manifests', component + '.yaml'];
        let text = host.fs.readFile(parts, null);
        for (const [from, to] of edit.replace || []) text = text.split(from).join(to);
        host.fs.writeFile(parts, text, null);
      }
      if (hc.packages) Object.assign(host.packages, hc.packages);
      if (hc.runningKubeletVersion) host.runningKubeletVersion = hc.runningKubeletVersion;
      if (hc.up !== undefined) host.up = !!hc.up;
    }

    // let controllers create their pods, then make everything look established
    Sim.reconcile(cluster);
    for (const pod of cluster.list(cluster.kinds.resolve('pod'), null)) {
      const st = cluster.simState(pod);
      const owner = (pod.metadata.ownerReferences || [])[0];
      let ownerObj = null;
      if (owner) for (const o of cluster.store.values()) if (o.metadata.uid === owner.uid) { ownerObj = o; break; }
      if (ownerObj && owner.kind === 'ReplicaSet') { const d = (ownerObj.metadata.ownerReferences || [])[0]; if (d) for (const o of cluster.store.values()) if (o.metadata.uid === d.uid) { ownerObj = o; break; } }
      const ts = ownerObj ? Date.parse(ownerObj.metadata.creationTimestamp) : Date.parse(pod.metadata.creationTimestamp);
      pod.metadata.creationTimestamp = iso(ts);
      st.createdAt = ts; st.scheduledAt = ts;
      st.pulledEventDone = true;
    }
    for (const rs of cluster.list(cluster.kinds.resolve('rs'), null)) {
      const d = (rs.metadata.ownerReferences || [])[0];
      if (d) for (const o of cluster.store.values()) if (o.metadata.uid === d.uid) { rs.metadata.creationTimestamp = o.metadata.creationTimestamp; break; }
    }
    cluster.events = [];
    Sim.reconcile(cluster);
    return cluster;
  }

  seedNodeFiles(host, cluster, n, isCP, cpNode) {
    const version = cluster.version;
    host.seedDir('/etc/kubernetes/manifests');
    host.seedDir('/etc/kubernetes/pki');
    host.seedDir('/var/lib/kubelet/pki');
    host.seedDir('/etc/cni/net.d');
    host.seedDir('/opt/cni/bin');
    host.seedDir('/var/log/pods');
    host.seedDir('/var/log/containers');
    host.seedFile('/etc/kubernetes/pki/ca.crt', PEM('CERTIFICATE', cluster.name + 'ca'));
    host.seedFile('/var/lib/kubelet/config.yaml', 'apiVersion: kubelet.config.k8s.io/v1beta1\nauthentication:\n  anonymous:\n    enabled: false\n  webhook:\n    cacheTTL: 0s\n    enabled: true\n  x509:\n    clientCAFile: /etc/kubernetes/pki/ca.crt\nauthorization:\n  mode: Webhook\n  webhook:\n    cacheAuthorizedTTL: 0s\n    cacheUnauthorizedTTL: 0s\ncgroupDriver: systemd\nclusterDNS:\n- 10.96.0.10\nclusterDomain: cluster.local\ncontainerRuntimeEndpoint: unix:///var/run/containerd/containerd.sock\ncpuManagerReconcilePeriod: 0s\nevictionPressureTransitionPeriod: 0s\nfileCheckFrequency: 0s\nhealthzBindAddress: 127.0.0.1\nhealthzPort: 10248\nhttpCheckFrequency: 0s\nimageMaximumGCAge: 0s\nimageMinimumGCAge: 0s\nkind: KubeletConfiguration\nlogging:\n  flushFrequency: 0\n  options:\n    json:\n      infoBufferSize: "0"\n    text:\n      infoBufferSize: "0"\n  verbosity: 0\nmemorySwap: {}\nnodeStatusReportFrequency: 0s\nnodeStatusUpdateFrequency: 0s\nrotateCertificates: true\nruntimeRequestTimeout: 0s\nshutdownGracePeriod: 0s\nshutdownGracePeriodCriticalPods: 0s\nstaticPodPath: /etc/kubernetes/manifests\nstreamingConnectionIdleTimeout: 0s\nsyncFrequency: 0s\nvolumeStatsAggPeriod: 0s\n');
    host.seedFile('/var/lib/kubelet/kubeadm-flags.env', 'KUBELET_KUBEADM_ARGS="--container-runtime-endpoint=unix:///var/run/containerd/containerd.sock --pod-infra-container-image=registry.k8s.io/pause:3.10"\n');
    host.seedDir('/etc/systemd/system/kubelet.service.d');
    host.seedFile('/etc/systemd/system/kubelet.service.d/10-kubeadm.conf', '# Note: This dropin only works with kubeadm and kubelet v1.11+\n[Service]\nEnvironment="KUBELET_KUBECONFIG_ARGS=--bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf --kubeconfig=/etc/kubernetes/kubelet.conf"\nEnvironment="KUBELET_CONFIG_ARGS=--config=/var/lib/kubelet/config.yaml"\n# This is a file that "kubeadm init" and "kubeadm join" generates at runtime, populating the KUBELET_KUBEADM_ARGS variable dynamically\nEnvironmentFile=-/var/lib/kubelet/kubeadm-flags.env\n# This is a file that the user can use for overrides of the kubelet args as a last resort. Preferably, the user should use\n# the .NodeRegistration.KubeletExtraArgs object in the configuration files instead. KUBELET_EXTRA_ARGS should be sourced from this file.\nEnvironmentFile=-/etc/default/kubelet\nExecStart=\nExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS\n');
    host.seedDir('/usr/lib/systemd/system');
    host.seedFile('/usr/lib/systemd/system/kubelet.service', '[Unit]\nDescription=kubelet: The Kubernetes Node Agent\nDocumentation=https://kubernetes.io/docs/\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nExecStart=/usr/bin/kubelet\nRestart=always\nStartLimitInterval=0\nRestartSec=10\n\n[Install]\nWantedBy=multi-user.target\n');
    host.seedFile('/etc/kubernetes/kubelet.conf', kubeconfigText('kubernetes', 'https://' + cpNode.ip + ':6443', 'system:node:' + n.name), { mode: 0o600 });
    host.seedFile('/etc/cni/net.d/10-flannel.conflist', '{\n  "name": "cbr0",\n  "cniVersion": "0.3.1",\n  "plugins": [\n    {\n      "type": "flannel",\n      "delegate": {\n        "hairpinMode": true,\n        "isDefaultGateway": true\n      }\n    },\n    {\n      "type": "portmap",\n      "capabilities": {\n        "portMappings": true\n      }\n    }\n  ]\n}\n');
    host.seedFile('/var/lib/kubelet/pki/kubelet.crt', PEM('CERTIFICATE', n.name + 'kubelet'), { mode: 0o644 });
    host.seedFile('/var/lib/kubelet/pki/kubelet.key', PEM('EC PRIVATE KEY', n.name + 'kubeletkey'), { mode: 0o600 });
    if (!isCP) return;
    host.seedDir('/etc/kubernetes/pki/etcd');
    for (const f of ['apiserver', 'apiserver-kubelet-client', 'apiserver-etcd-client', 'front-proxy-client']) { host.seedFile('/etc/kubernetes/pki/' + f + '.crt', PEM('CERTIFICATE', f)); host.seedFile('/etc/kubernetes/pki/' + f + '.key', PEM('RSA PRIVATE KEY', f + 'key'), { mode: 0o600 }); }
    host.seedFile('/etc/kubernetes/pki/ca.key', PEM('RSA PRIVATE KEY', 'cakey'), { mode: 0o600 });
    host.seedFile('/etc/kubernetes/pki/front-proxy-ca.crt', PEM('CERTIFICATE', 'fpca'));
    host.seedFile('/etc/kubernetes/pki/front-proxy-ca.key', PEM('RSA PRIVATE KEY', 'fpcakey'), { mode: 0o600 });
    host.seedFile('/etc/kubernetes/pki/sa.key', PEM('RSA PRIVATE KEY', 'sakey'), { mode: 0o600 });
    host.seedFile('/etc/kubernetes/pki/sa.pub', PEM('PUBLIC KEY', 'sapub'));
    for (const f of ['ca', 'server', 'peer', 'healthcheck-client']) { host.seedFile('/etc/kubernetes/pki/etcd/' + f + '.crt', PEM('CERTIFICATE', 'etcd' + f), { mode: 0o644 }); host.seedFile('/etc/kubernetes/pki/etcd/' + f + '.key', PEM('RSA PRIVATE KEY', 'etcd' + f + 'key'), { mode: 0o600 }); }
    for (const c of ['admin', 'super-admin', 'controller-manager', 'scheduler']) host.seedFile('/etc/kubernetes/' + c + '.conf', kubeconfigText('kubernetes', 'https://' + n.ip + ':6443', c === 'admin' || c === 'super-admin' ? 'kubernetes-' + c : 'system:kube-' + c), { mode: 0o600 });
    host.seedDir('/var/lib/etcd/member/snap', { mode: 0o700 });
    host.seedDir('/var/lib/etcd/member/wal', { mode: 0o700 });
    host.seedFile('/var/lib/etcd/member/snap/db', 'etcd-db ' + shortHash(cluster.name, 32), { mode: 0o600 });
    for (const component of ['etcd', 'kube-apiserver', 'kube-controller-manager', 'kube-scheduler']) {
      const m = staticPodManifest(component, { ip: n.ip, version, etcdVersion: '3.5.15-0' });
      host.seedFile('/etc/kubernetes/manifests/' + component + '.yaml', m.text, { mode: 0o600 });
      const flagSet = new Set([...m.flags, ...EXTRA_STATIC_FLAGS[component]]);
      cluster.staticPodFlags[component] = flagSet;
    }
  }

  /* After 'kubeadm upgrade apply', manifests and images move to the new version. */
  upgradeControlPlane(cluster, host, version) {
    cluster.version = version;
    for (const component of ['etcd', 'kube-apiserver', 'kube-controller-manager', 'kube-scheduler']) {
      const m = staticPodManifest(component, { ip: host.ip, version, etcdVersion: '3.5.15-0' });
      host.seedFile('/etc/kubernetes/manifests/' + component + '.yaml', m.text, { mode: 0o600 });
      const pod = cluster.getByKindName('Pod', 'kube-system', component + '-' + host.hostname);
      if (pod && component !== 'etcd') pod.spec.containers[0].image = 'registry.k8s.io/' + component + ':v' + version;
    }
    const kp = cluster.getByKindName('DaemonSet', 'kube-system', 'kube-proxy');
    if (kp) { kp.spec.template.spec.containers[0].image = 'registry.k8s.io/kube-proxy:v' + version; kp.metadata.generation++; }
    const kc = cluster.getByKindName('ConfigMap', 'kube-system', 'kubeadm-config');
    if (kc) kc.data.ClusterConfiguration = kc.data.ClusterConfiguration.replace(/kubernetesVersion: v[\d.]+/, 'kubernetesVersion: v' + version);
    Sim.reconcile(cluster);
  }
}
