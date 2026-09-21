/* build.mjs — dependency-free bundler for mockctl exam lab.
   Validates and embeds exams/*.json as BUILTIN_EXAMS, concatenates src/js
   in order inside one IIFE, copies static/ as-is, and emits dist/index.html
   (standalone), dist/artifact.html (no document wrapper), dist/bundle.js. */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(root, 'src', p), 'utf8');

const SITE_URL = 'https://mockctl.com';
const TITLE = 'mockctl exam lab';
const DESCRIPTION = 'Free, browser-only practice lab in the CKA, CKAD and CKS exam format: simulated clusters, kubectl, node and security tooling, timed tasks with instant grading. No server, no account, no network calls. Unofficial; not affiliated with The Linux Foundation or CNCF.';

const JS_FILES = [
  'js/util.js',
  'js/yaml.js',
  'js/core/errors.js',
  'js/core/user.js',
  'js/core/vnode.js',
  'js/core/filesystem.js',
  'js/core/host.js',
  'js/core/network.js',
  'js/core/session.js',
  'js/envstore.js',
  'js/terminal.js',
  'js/registry.js',
  'js/k8s/kinds.js',
  'js/k8s/cluster.js',
  'js/k8s/sim.js',
  'js/k8s/printers.js',
  'js/k8s/rbac.js',
  'js/k8s/kubectl.js',
  'js/k8s/world.js',
  'js/exam/checks.js',
  'js/exam/exam.js',
  'js/exam/ui.js',
  'js/shell.js',
  'js/vim.js',
  'js/commands/fsops.js',
  'js/commands/text.js',
  'js/commands/perms.js',
  'js/commands/net.js',
  'js/commands/nodetools.js',
  'js/commands/security.js',
  'js/commands/helm.js',
  'js/commands/sessioncmds.js',
  'js/commands/examcmd.js',
  'js/app.js',
];

const exams = {};
const examDir = join(root, 'exams');
for (const f of readdirSync(examDir).filter(f => f.endsWith('.json')).sort()) {
  const cfg = JSON.parse(readFileSync(join(examDir, f), 'utf8'));
  if (!cfg.uuid || !/^[0-9a-f-]{36}$/i.test(cfg.uuid)) throw new Error(f + ': missing or malformed uuid');
  const key = cfg.uuid.toLowerCase();
  if (exams[key]) throw new Error(f + ': duplicate uuid ' + key);
  const weights = (cfg.questions || []).reduce((n, q) => n + (q.weight || 0), 0);
  console.log('  exam ' + f + ': ' + (cfg.questions || []).length + ' questions, total weight ' + weights);
  exams[key] = cfg;
}
if (!Object.keys(exams).length) throw new Error('exams/ must contain at least one exam');

const examsChunk = '/* ===== built-in exams (generated from exams/) ===== */\nconst BUILTIN_EXAMS = ' + JSON.stringify(exams) + ';\n';
const js = JS_FILES.map(f => `/* ===== ${f} ===== */\n` + src(f)).join('\n');
const bundle = `(() => {\n'use strict';\n${examsChunk}\n${js}\n})();\n`;
const css = src('styles.css');
const markup = src('app.html');

/* Share-preview and search metadata. og:image must be absolute; the favicon is
   relative so the page also works when opened from disk. */
const meta = [
  `<meta name="description" content="${DESCRIPTION}">`,
  `<link rel="canonical" href="${SITE_URL}/">`,
  `<link rel="icon" href="favicon.png" type="image/png">`,
  `<meta property="og:type" content="website">`,
  `<meta property="og:site_name" content="${TITLE}">`,
  `<meta property="og:title" content="${TITLE}">`,
  `<meta property="og:description" content="${DESCRIPTION}">`,
  `<meta property="og:url" content="${SITE_URL}/">`,
  `<meta property="og:image" content="${SITE_URL}/og.png">`,
  `<meta property="og:image:width" content="1200">`,
  `<meta property="og:image:height" content="630">`,
  `<meta property="og:image:alt" content="mockctl exam lab: a terminal with a kubectl session beside the site name and tagline">`,
  `<meta name="twitter:card" content="summary_large_image">`,
  `<meta name="twitter:title" content="${TITLE}">`,
  `<meta name="twitter:description" content="${DESCRIPTION}">`,
  `<meta name="twitter:image" content="${SITE_URL}/og.png">`,
].join('\n');

const artifact = `<title>${TITLE}</title>\n<style>\n${css}</style>\n${markup}<script>\n${bundle}</script>\n`;
const standalone = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${TITLE}</title>\n${meta}\n<style>\n${css}</style>\n</head>\n<body>\n${markup}<script>\n${bundle}</script>\n</body>\n</html>\n`;

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'bundle.js'), bundle);
writeFileSync(join(root, 'dist', 'artifact.html'), artifact);
writeFileSync(join(root, 'dist', 'index.html'), standalone);

// static/ is copied into dist/ unchanged: share image, favicon, 404 page,
// Cloudflare _headers, and .assetsignore (keeps bundle.js/artifact.html off the site).
const staticDir = join(root, 'static');
const copied = readdirSync(staticDir);
for (const f of copied) copyFileSync(join(staticDir, f), join(root, 'dist', f));
console.log('built dist/index.html (' + standalone.length + ' chars), dist/artifact.html, dist/bundle.js; copied ' + copied.length + ' static files');
