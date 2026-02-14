const state = {
  client: null,
  db: null,
  antiNuke: null,
  antiNukeRollback: null
};

function setSlot(key, value) {
  if (value === undefined || value === null) {
    return state[key] || null;
  }
  state[key] = value;
  return state[key];
}

const runtime = {
  setClient(client) {
    return setSlot('client', client);
  },
  setDb(db) {
    return setSlot('db', db);
  },
  setAntiNuke(antiNuke) {
    return setSlot('antiNuke', antiNuke);
  },
  setAntiNukeRollback(antiNukeRollback) {
    return setSlot('antiNukeRollback', antiNukeRollback);
  },
  clearClient() {
    state.client = null;
  },
  clearDb() {
    state.db = null;
  },
  clearAntiNuke() {
    state.antiNuke = null;
  },
  clearAntiNukeRollback() {
    state.antiNukeRollback = null;
  },
  resetForTests() {
    if (process.env.NODE_ENV !== 'test') return;
    state.client = null;
    state.db = null;
    state.antiNuke = null;
    state.antiNukeRollback = null;
  },
  getClient() {
    return state.client || null;
  },
  getDb() {
    return state.db || null;
  },
  getAntiNuke() {
    return state.antiNuke || null;
  },
  getAntiNukeRollback() {
    return state.antiNukeRollback || null;
  }
};

module.exports = Object.freeze(runtime);
