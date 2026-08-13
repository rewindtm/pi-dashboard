const TOKEN = process.env.DASHBOARD_TOKEN;

function checkToken(token) {
  return typeof token === 'string' && token.length > 0 && token === TOKEN;
}

function httpAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = bearer || req.query.token;
  if (!checkToken(token)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

module.exports = { httpAuth, checkToken };
