const express = require('express');
const si = require('systeminformation');

const router = express.Router();

router.get('/stats', async (req, res) => {
  try {
    const [cpu, cpuTemp, mem, fsSize, time, load, osInfo, networkStats] = await Promise.all([
      si.cpu(),
      si.cpuTemperature(),
      si.mem(),
      si.fsSize(),
      Promise.resolve(si.time()),
      si.currentLoad(),
      si.osInfo(),
      si.networkStats().catch(() => []),
    ]);
    res.json({
      cpu: { manufacturer: cpu.manufacturer, brand: cpu.brand, cores: cpu.cores, speed: cpu.speed },
      cpuTemp,
      load: { currentLoad: load.currentLoad, avgLoad: load.avgLoad },
      mem: { total: mem.total, used: mem.active, free: mem.available },
      fs: fsSize.map((d) => ({ fs: d.fs, mount: d.mount, size: d.size, used: d.used, use: d.use })),
      uptime: time.uptime,
      os: { platform: osInfo.platform, distro: osInfo.distro, release: osInfo.release, arch: osInfo.arch, hostname: osInfo.hostname },
      network: networkStats.map((n) => ({ iface: n.iface, rx_sec: n.rx_sec, tx_sec: n.tx_sec })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
