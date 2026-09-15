/* envstore.js — resolves environment configs by UUID (or name).
   Built-in environments are compiled into the bundle at build time
   (BUILTIN_ENVS is injected by build.mjs); imported ones are kept in
   localStorage so a UUID can be recalled on a later visit. */

const IMPORT_KEY = 'mockctlEnvironments';

class EnvironmentStore {
  constructor(builtins) {
    this.builtins = builtins;   // uuid -> config
    this.imported = {};         // uuid -> config
    try {
      const raw = localStorage.getItem(IMPORT_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') this.imported = data;
      }
    } catch (e) { /* storage unavailable; imports just won't survive reloads */ }
  }

  saveImports() {
    try { localStorage.setItem(IMPORT_KEY, JSON.stringify(this.imported)); return true; }
    catch (e) { return false; }
  }

  /* All known configs, builtin first. */
  entries() {
    const seen = new Set();
    const out = [];
    for (const [uuid, cfg] of Object.entries(this.builtins)) { out.push({ uuid, cfg, builtin: true }); seen.add(uuid); }
    for (const [uuid, cfg] of Object.entries(this.imported)) if (!seen.has(uuid)) out.push({ uuid, cfg, builtin: false });
    return out;
  }

  /* Find by UUID (exact, case-insensitive) or by name; name matching
     treats spaces, hyphens and underscores as equivalent. */
  findConfig(id) {
    const low = String(id).toLowerCase();
    for (const e of this.entries()) {
      if (e.uuid.toLowerCase() === low) return e.cfg;
    }
    const slug = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, '-');
    for (const e of this.entries()) {
      if (slug(e.cfg.name || '') === slug(id)) return e.cfg;
    }
    return null;
  }

  /* Register an imported config (validated by the caller). */
  register(cfg) {
    this.imported[cfg.uuid.toLowerCase()] = cfg;
    return this.saveImports();
  }

  forget(uuid) {
    const low = String(uuid).toLowerCase();
    if (!(low in this.imported)) return false;
    delete this.imported[low];
    this.saveImports();
    return true;
  }
}
