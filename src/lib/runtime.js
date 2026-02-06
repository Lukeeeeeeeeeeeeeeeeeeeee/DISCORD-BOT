const runtime = {
  client: null,
  db: null,
  antiNuke: null,
  antiNukeRollback: null,
  setClient(client) {
    this.client = client || null;
  },
  setDb(db) {
    this.db = db || null;
  },
  setAntiNuke(antiNuke) {
    this.antiNuke = antiNuke || null;
  },
  setAntiNukeRollback(antiNukeRollback) {
    this.antiNukeRollback = antiNukeRollback || null;
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
