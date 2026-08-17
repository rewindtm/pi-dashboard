const express = require('express');
const { execFile } = require('child_process');

const router = express.Router();

router.post('/reboot', (req, res) => {
  res.json({ ok: true, message: 'Riavvio in corso...' });
  execFile('sudo', ['reboot']);
});

router.post('/shutdown', (req, res) => {
  res.json({ ok: true, message: 'Spegnimento in corso...' });
  execFile('sudo', ['shutdown', 'now']);
});

module.exports = router;
