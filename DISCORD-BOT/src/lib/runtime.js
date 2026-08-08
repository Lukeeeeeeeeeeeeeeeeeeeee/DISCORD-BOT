const runtime = {
  client: null,
  db: null,
  antiNuke: null,
  antiNukeRollback: null,
  setClient(client) {
    if (client == null) return;
    this.client = client;
  },
  setDb(db) {
    if (db == null) return;
    this.db = db;
  },
  setAntiNuke(antiNuke) {
    if (antiNuke == null) return;
    this.antiNuke = antiNuke;
  },
  setAntiNukeRollback(antiNukeRollback) {
    if (antiNukeRollback == null) return;
    this.antiNukeRollback = antiNukeRollback;
  },
  clearClient() {
    this.client = null;
  },
  clearDb() {
    this.db = null;
  },
  clearAntiNuke() {
    this.antiNuke = null;
  },
  clearAntiNukeRollback() {
    this.antiNukeRollback = null;
  },
  resetForTests() {
    this.client = null;
    this.db = null;
    this.antiNuke = null;
    this.antiNukeRollback = null;
  },
  getClient() {
    return this.client || null;
  },
  getDb() {
    return this.db || null;
  },
  getAntiNuke() {
    return this.antiNuke || null;
  },
  getAntiNukeRollback() {
    return this.antiNukeRollback || null;
  }
};

module.exports = runtime;
