const express = require('express');
const fs = require('fs');
const { execFile } = require('child_process');

const router = express.Router();
router.use(express.json());

const HELPER = '/usr/local/bin/pi-disk';
const DEVICE = /^\/dev\/(sd[a-z]+[0-9]*|nvme[0-9]+n[0-9]+(p[0-9]+)?)$/;
const MOUNTABLE = new Set(['ntfs', 'exfat', 'vfat', 'ext2', 'ext3', 'ext4', 'btrfs', 'xfs']);
const ACTIONS = { mount: 'mount', unmount: 'unmount', eject: 'eject' };

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || (err ? err.message : '')).trim() });
    });
  });
}

function fstabAutomount() {
  try {
    const set = new Set();
    for (const line of fs.readFileSync('/etc/fstab', 'utf8').split('\n')) {
      const m = line.match(/^UUID=(\S+)\s.*# pi-dashboard\s*$/);
      if (m) set.add(m[1]);
    }
    return set;
  } catch {
    return new Set();
  }
}

// Restituisce i dischi reali (esclusi loop/ram/zram) con le loro partizioni.
async function listDisks() {
  const r = await run('lsblk', ['-J', '-b', '-o', 'NAME,PATH,SIZE,TYPE,FSTYPE,LABEL,UUID,MOUNTPOINT,RM,TRAN,MODEL,FSUSED,FSAVAIL,RO']);
  if (!r.ok) throw new Error(r.stderr || 'lsblk non disponibile');
  const auto = fstabAutomount();

  const mountpoints = (d) => [d.mountpoint, ...(d.children || []).flatMap(mountpoints)].filter(Boolean);
  const toPart = (p, system) => ({
    path: p.path,
    name: p.name,
    label: p.label,
    fstype: p.fstype,
    uuid: p.uuid,
    size: Number(p.size),
    mountpoint: p.mountpoint,
    used: p.fsused == null ? null : Number(p.fsused),
    avail: p.fsavail == null ? null : Number(p.fsavail),
    readOnly: !!p.ro,
    automount: !!(p.uuid && auto.has(p.uuid)),
    mountable: !system && MOUNTABLE.has(p.fstype),
  });

  const tree = JSON.parse(r.stdout).blockdevices;
  const raids = buildRaids(tree);
  const memberOf = {};
  for (const a of raids) for (const m of a.members) memberOf[m.path] = a.name;

  const disks = tree
    .filter((d) => d.type === 'disk' && !/^(ram|zram|loop)/.test(d.name))
    .map((d) => {
      const mps = mountpoints(d);
      const system = mps.some((m) => m === '/' || m.startsWith('/boot'));
      const parts = (d.children || []).filter((c) => c.type === 'part');
      return {
        name: d.name,
        path: d.path,
        model: d.model ? d.model.trim() : null,
        size: Number(d.size),
        transport: d.tran,
        removable: !!d.rm,
        system,
        // disco senza tabella delle partizioni: il filesystem sta sul disco stesso
        partitions: (parts.length ? parts.map((p) => toPart(p, system)) : d.fstype ? [toPart(d, system)] : [])
          .map((p) => ({ ...p, raid: memberOf[p.path] || null })),
        canEject: !system && d.name.startsWith('sd') && !(d.children || []).some((c) => memberOf[c.path]),
      };
    });
  return { disks, raids };
}

// Array md (RAID) dall'albero di lsblk (membri e punti di mount) e da /proc/mdstat (stato, sincronizzazione).
function buildRaids(tree) {
  const arrays = {};
  const walk = (node, parent) => {
    if (/^raid/.test(node.type) || node.type === 'md') {
      const a = (arrays[node.name] ||= {
        name: node.name, path: node.path, level: node.type, size: Number(node.size),
        fstype: node.fstype, label: node.label, mountpoint: node.mountpoint,
        used: node.fsused == null ? null : Number(node.fsused),
        avail: node.fsavail == null ? null : Number(node.fsavail),
        members: [],
      });
      if (parent && !a.members.some((m) => m.path === parent.path)) {
        a.members.push({ path: parent.path, name: parent.name, size: Number(parent.size) });
      }
    }
    for (const c of node.children || []) walk(c, node);
  };
  for (const d of tree) walk(d, null);

  let text = '';
  try { text = fs.readFileSync('/proc/mdstat', 'utf8'); } catch { /* niente md */ }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(md\d+)\s*:\s*(\S+)\s+(\S+)\s+(.*)$/);
    if (!m || !arrays[m[1]]) continue;
    const a = arrays[m[1]];
    a.active = m[2] === 'active';
    const failed = new Set();
    for (const dev of m[4].split(/\s+/)) {
      const d = dev.match(/^([a-z0-9]+)\[\d+\](\(F\))?/);
      if (d && d[2]) failed.add(d[1]);
    }
    a.members.forEach((mb) => { mb.failed = failed.has(mb.name); });
    const st = (lines[i + 1] || '').match(/\[(\d+)\/(\d+)\]\s*\[([U_]+)\]/);
    if (st) { a.total = Number(st[1]); a.working = Number(st[2]); a.map = st[3]; }
    for (let j = i + 1; j < i + 4 && lines[j] && !/^md\d+/.test(lines[j]); j++) {
      const s = lines[j].match(/(resync|recovery|reshape|check)\s*=\s*([\d.]+)%/);
      if (s) {
        const fin = lines[j].match(/finish=([\d.]+)min/);
        const spd = lines[j].match(/speed=(\d+)K\/sec/);
        a.sync = {
          action: s[1], percent: Number(s[2]),
          finishMin: fin ? Number(fin[1]) : null,
          speedKB: spd ? Number(spd[1]) : null,
        };
      }
    }
    a.degraded = a.total != null && a.working < a.total;
  }
  return Object.values(arrays);
}

const DISK = /^\/dev\/(sd[a-z]+|nvme[0-9]+n[0-9]+)$/;
const FORMAT_TOOLS = { ext4: 'mkfs.ext4', exfat: 'mkfs.exfat', ntfs: 'mkntfs' };
const LABEL = /^[A-Za-z0-9_-]{0,15}$/;

function hasTool(bin) {
  return ['/usr/sbin/', '/sbin/', '/usr/bin/'].some((d) => fs.existsSync(d + bin));
}

// --- SMART (sola lettura, tramite l'helper privilegiato; cache di 5 minuti per disco) ---
const SMART_DISK = /^\/dev\/(sd[a-z]+|nvme[0-9]+n[0-9]+)$/;
const smartCache = new Map();

function summarizeSmart(j) {
  const attrs = {};
  for (const a of (j.ata_smart_attributes && j.ata_smart_attributes.table) || []) attrs[a.id] = a;
  const raw = (id) => (attrs[id] ? Number(attrs[id].raw.value) : null);
  const nvme = j.nvme_smart_health_information_log;
  let lifeLeft = null;
  if (nvme && nvme.percentage_used != null) lifeLeft = Math.max(0, 100 - nvme.percentage_used);
  else {
    const life = [177, 202, 231, 233, 169].filter((id) => attrs[id]).map((id) => attrs[id].value);
    if (life.length) lifeLeft = Math.min(...life);
  }
  const out = {
    model: j.model_name || null,
    passed: j.smart_status ? !!j.smart_status.passed : null,
    temp: (j.temperature && j.temperature.current) ?? (nvme && nvme.temperature) ?? null,
    hours: (j.power_on_time && j.power_on_time.hours) ?? (nvme && nvme.power_on_hours) ?? null,
    lifeLeft,
    reallocated: raw(5),
    pending: raw(197),
    uncorrectable: raw(198) ?? raw(187),
    crc: raw(199),
    mediaErrors: nvme ? nvme.media_errors : null,
    spare: nvme ? nvme.available_spare : null,
  };
  const bad = out.passed === false || out.pending > 0 || out.uncorrectable > 0 || out.mediaErrors > 0 || (out.lifeLeft != null && out.lifeLeft < 10);
  const warn = out.reallocated > 0 || out.crc > 0 || (out.temp != null && out.temp >= 60) || (out.lifeLeft != null && out.lifeLeft < 30);
  out.verdict = bad ? 'bad' : warn ? 'warn' : 'ok';
  return out;
}

router.get('/smart', async (req, res) => {
  const device = String(req.query.device || '');
  if (!SMART_DISK.test(device)) return res.status(400).json({ error: 'dispositivo non valido' });
  const hit = smartCache.get(device);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000 && !req.query.fresh) return res.json(hit.data);
  const r = await run('sudo', ['-n', HELPER, 'smart', device], 60000);
  if (!r.ok && /password is required|not allowed|a terminal is required/.test(r.stderr)) {
    return res.status(412).json({ error: 'SMART non abilitato: esegui sul Pi "sudo bash ~/pi-dashboard/scripts/setup-disks.sh"' });
  }
  if (!r.ok && /manca smartctl/.test(r.stderr)) return res.status(412).json({ error: 'smartctl non installato: esegui "sudo apt install smartmontools"' });
  if (!r.ok && /azione non valida|dispositivo non valido|disco di sistema/.test(r.stderr)) {
    return res.status(412).json({ error: 'helper non aggiornato: esegui sul Pi "sudo bash ~/pi-dashboard/scripts/setup-disks.sh"' });
  }
  try {
    const data = summarizeSmart(JSON.parse(r.stdout));
    smartCache.set(device, { at: Date.now(), data });
    res.json(data);
  } catch {
    res.status(500).json({ error: 'risposta SMART non leggibile' });
  }
});

router.get('/', async (req, res) => {
  try {
    const helperInstalled = fs.existsSync(HELPER);
    const formatTools = Object.fromEntries(Object.entries(FORMAT_TOOLS).map(([fsType, bin]) => [fsType, hasTool(bin)]));
    const { disks, raids } = await listDisks();
    res.json({ disks, raids, helperInstalled, formatTools });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function helper(res, args, timeout) {
  const r = await run('sudo', ['-n', HELPER, ...args], timeout);
  if (r.ok) return res.json({ ok: true, output: r.stdout });
  if (/password is required|not allowed|a terminal is required/.test(r.stderr) || !fs.existsSync(HELPER)) {
    return res.status(412).json({ error: 'Sezione Dischi non abilitata: esegui una volta sul Pi "sudo bash ~/pi-dashboard/scripts/setup-disks.sh"' });
  }
  res.status(500).json({ error: r.stderr || 'operazione fallita' });
}

function validDevice(req, res) {
  const { device } = req.body || {};
  if (typeof device !== 'string' || !DEVICE.test(device)) {
    res.status(400).json({ error: 'dispositivo non valido' });
    return null;
  }
  return device;
}

router.post('/:action(mount|unmount|eject)', async (req, res) => {
  const device = validDevice(req, res);
  if (device) helper(res, [ACTIONS[req.params.action], device]);
});

router.post('/automount', async (req, res) => {
  const device = validDevice(req, res);
  if (device) helper(res, [req.body.enabled ? 'automount-on' : 'automount-off', device]);
});

// Cancella tutto il disco. Barriere: disco intero non di sistema, nulla di montato,
// conferma scritta del nome del disco (es. "sda").
router.post('/format', async (req, res) => {
  const { device, fstype, label = '', confirm } = req.body || {};
  if (typeof device !== 'string' || !DISK.test(device)) return res.status(400).json({ error: 'indica un disco intero (es. /dev/sda)' });
  if (!FORMAT_TOOLS[fstype]) return res.status(400).json({ error: 'filesystem non supportato' });
  if (typeof label !== 'string' || !LABEL.test(label)) return res.status(400).json({ error: 'etichetta non valida (max 15 caratteri: lettere, numeri, - _)' });
  if (confirm !== device.replace('/dev/', '')) return res.status(400).json({ error: 'conferma errata: digita il nome del disco' });

  let disks;
  try {
    disks = (await listDisks()).disks;
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  const disk = disks.find((d) => d.path === device);
  if (!disk) return res.status(404).json({ error: 'disco non trovato' });
  if (disk.partitions.some((p) => p.raid || p.fstype === 'linux_raid_member')) return res.status(403).json({ error: 'disco membro di un RAID: non formattabile da qui' });
  if (disk.system) return res.status(403).json({ error: 'disco di sistema: non formattabile' });
  if (disk.partitions.some((p) => p.mountpoint)) return res.status(409).json({ error: 'smonta prima tutte le partizioni del disco' });

  helper(res, ['format', device, fstype, label], 10 * 60 * 1000);
});

module.exports = router;
