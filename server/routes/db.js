const express = require('express');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { readJson, writeJson } = require('../store');

const router = express.Router();

const NAME_RE = /^[a-z][a-z0-9_]{2,62}$/;

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: stderr || (err ? err.message : '') });
    });
  });
}

function psql(args, timeout = 20000) {
  return run('sudo', ['-u', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', ...args], timeout);
}

const getDbs = () => readJson('databases.json', []);
const saveDbs = (dbs) => writeJson('databases.json', dbs);

router.get('/status', async (req, res) => {
  const which = await run('which', ['psql']);
  if (!which.ok) return res.json({ installed: false, active: false });
  const active = await run('systemctl', ['is-active', 'postgresql']);
  res.json({ installed: true, active: active.stdout === 'active' });
});

router.post('/install', async (req, res) => {
  const install = await run('sudo', ['apt-get', 'install', '-y', 'postgresql'], 180000);
  if (!install.ok) return res.status(500).json({ error: 'installazione fallita', detail: install.stderr });
  await run('sudo', ['systemctl', 'enable', '--now', 'postgresql']);
  res.json({ ok: true });
});

router.get('/', async (req, res) => {
  const dbs = getDbs();
  const listRes = await psql(['-tAc', 'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname;']);
  const liveNames = listRes.ok ? listRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  res.json({
    databases: dbs.map((d) => ({ ...d, exists: liveNames.includes(d.dbName) })),
    postgresReachable: listRes.ok,
  });
});

router.post('/create', express.json(), async (req, res) => {
  const name = (req.body?.name || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    return res.status(400).json({ error: 'nome non valido: minuscolo, cifre e underscore, inizia con una lettera, 3-63 caratteri' });
  }

  const dbs = getDbs();
  if (dbs.some((d) => d.dbName === name)) return res.status(409).json({ error: 'esiste già una voce con questo nome' });

  const password = crypto.randomBytes(18).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);

  const createRole = await psql(['-c', `CREATE ROLE "${name}" WITH LOGIN PASSWORD '${password}';`]);
  if (!createRole.ok) return res.status(500).json({ error: 'creazione utente fallita', detail: createRole.stderr });

  const createDb = await psql(['-c', `CREATE DATABASE "${name}" OWNER "${name}";`]);
  if (!createDb.ok) {
    await psql(['-c', `DROP ROLE IF EXISTS "${name}";`]);
    return res.status(500).json({ error: 'creazione database fallita', detail: createDb.stderr });
  }

  const record = {
    id: name,
    dbName: name,
    roleName: name,
    password,
    connectionString: `postgresql://${name}:${password}@localhost:5432/${name}`,
    forApp: req.body?.forApp || null,
    createdAt: new Date().toISOString(),
  };
  dbs.push(record);
  saveDbs(dbs);
  res.json({ ok: true, database: record });
});

router.get('/:name/tables', async (req, res) => {
  const name = req.params.name;
  if (!NAME_RE.test(name)) return res.status(400).json({ error: 'nome non valido' });

  const colsRes = await psql([
    '-d', name, '-tAc',
    "SELECT table_name || E'\\x1f' || column_name || E'\\x1f' || data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position;",
  ]);
  if (!colsRes.ok) return res.status(500).json({ error: 'connessione al database fallita', detail: colsRes.stderr });

  const columnsByTable = {};
  for (const line of colsRes.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [table, col, type] = line.split('\x1f');
    if (!columnsByTable[table]) columnsByTable[table] = [];
    columnsByTable[table].push({ name: col, type });
  }

  const tables = [];
  for (const table of Object.keys(columnsByTable)) {
    const countRes = await psql(['-d', name, '-tAc', `SELECT COUNT(*) FROM "${table}";`]);
    tables.push({
      name: table,
      columns: columnsByTable[table],
      rowCount: countRes.ok ? Number(countRes.stdout.trim()) : null,
    });
  }

  res.json({ tables });
});

router.delete('/:name', async (req, res) => {
  const name = req.params.name;
  const dbs = getDbs();
  const idx = dbs.findIndex((d) => d.dbName === name);
  if (idx === -1) return res.status(404).json({ error: 'non trovato' });

  await psql(['-c', `DROP DATABASE IF EXISTS "${name}";`]);
  await psql(['-c', `DROP ROLE IF EXISTS "${name}";`]);

  dbs.splice(idx, 1);
  saveDbs(dbs);
  res.json({ ok: true });
});

module.exports = router;
