const pty = require('node-pty');
const { checkToken } = require('./auth');

const SHELL = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');

function attachTerminalServer(wss) {
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (!checkToken(token)) {
      ws.close(4001, 'unauthorized');
      return;
    }

    const term = pty.spawn(SHELL, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.env.HOME || process.env.USERPROFILE,
      env: process.env,
    });

    term.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data }));
    });
    term.onExit(({ exitCode }) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
      ws.close();
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'input') term.write(msg.data);
      else if (msg.type === 'resize') term.resize(Math.max(1, msg.cols | 0), Math.max(1, msg.rows | 0));
    });

    ws.on('close', () => {
      try { term.kill(); } catch {}
    });
  });
}

module.exports = { attachTerminalServer };
