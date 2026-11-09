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

  return JSON.parse(r.stdout).blockdevices
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
        partitions: parts.length ? parts.map((p) => toPart(p, system)) : d.fstype ? [toPart(d, system)] : [],
        canEject: !system && d.name.startsWith('sd'),
      };
    });
}

router.get('/', async (req, res) => {
  try {
    const helperInstalled = fs.existsSync(HELPER);
    res.json({ disks: await listDisks(), helperInstalled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function helper(res, args) {
  const r = await run('sudo', ['-n', HELPER, ...args]);
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

module.exports = router;
