/* core/user.js — a User belongs to a Host. Admins (uid 0) bypass
   permission checks; password null means passwordless login. */

class User {
  constructor({ name, password = null, admin = false, uid, attributes = {} }) {
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(name)) {
      throw new ConfigError('invalid username: ' + name);
    }
    this.name = name;
    this.password = password;
    this.admin = !!admin;
    this.uid = admin ? 0 : uid;
    this.attributes = attributes;   // free-form config-defined metadata
  }

  get homeParts() { return this.admin && this.name === 'root' ? ['root'] : ['home', this.name]; }

  authenticate(password) {
    return this.password === null || this.password === password;
  }
}
