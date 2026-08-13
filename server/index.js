require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { httpAuth, checkToken } = require('./auth');
const { attachTerminalServer } = require('./terminal');
const systemRoutes = require('./routes/system');
const servicesRoutes = require('./routes/services');
const filesRoutes = require('./routes/files');
const execRoutes = require('./routes/exec');

if (!process.env.DASHBOARD_TOKEN) {
  console.error('DASHBOARD_TOKEN non impostato. Copia .env.example in .env e imposta un token.');
  process.exit(1);
}

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/login', (req, res) => {
  res.json({ ok: checkToken(req.query.token) });
});

app.use('/api/system', httpAuth, systemRoutes);
app.use('/api/services', httpAuth, servicesRoutes);
app.use('/api/files', httpAuth, filesRoutes);
app.use('/api/exec', httpAuth, execRoutes);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/terminal' });
attachTerminalServer(wss);

const PORT = process.env.PORT || 7890;
server.listen(PORT, () => {
  console.log(`Pi Dashboard in ascolto su http://0.0.0.0:${PORT}`);
});
