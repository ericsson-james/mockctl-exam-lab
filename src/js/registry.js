/* registry.js — commands are objects registered here.
   spec: { name, usage, desc, aliases?, interactive?, run(ctx, args, io) }
   run may be async. `interactive` commands (ssh, su) refuse to be piped.
   ctx: { app, shell, term, env, session } */

class Command {
  constructor(spec) { Object.assign(this, spec); }
}

class CommandRegistry {
  constructor() {
    this.map = new Map();
  }
  register(spec) {
    const cmd = new Command(spec);
    this.map.set(cmd.name, cmd);
    for (const a of spec.aliases || []) this.map.set(a, cmd);
    return cmd;
  }
  get(name) { return this.map.get(name) || null; }
  names() { return [...this.map.keys()].sort(); }
}

const registry = new CommandRegistry();
