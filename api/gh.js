// Keyword Desk server function (Vercel).
// Checks the team or approver password, then talks to GitHub with the
// owner's token, which never leaves the server.
// Environment variables (Vercel → Settings → Environment Variables):
//   GITHUB_TOKEN       token of the repo owner (repo access)
//   GITHUB_REPO        e.g. husainpanvelwala-pixel/Brigde-Keywords
//   TEAM_PASSWORD      password for requesters
//   APPROVER_PASSWORD  password for approvers
const crypto = require('crypto');

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => !!a && !!b && crypto.timingSafeEqual(sha(a), sha(b));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PATH_OK = /^\/(contents\/[^?#]+|issues(\/\d+(\/comments)?)?)(\?[^#]*)?$/;

function allowed(role, method, path){
  if (!PATH_OK.test(path) || path.includes('..')) return false;
  if (role === 'approver') return ['GET', 'PUT', 'POST', 'PATCH'].includes(method);
  if (method === 'GET') return true;                                         // read list, files, requests
  if (method === 'PUT') return path.startsWith('/contents/reference-images/'); // upload reference image
  if (method === 'POST') return path === '/issues';                          // create a request
  return false;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ message: 'Use POST.' });
  const { GITHUB_TOKEN, GITHUB_REPO, TEAM_PASSWORD, APPROVER_PASSWORD } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPO || !TEAM_PASSWORD || !APPROVER_PASSWORD){
    return res.status(500).json({ message: 'The site isn’t set up yet: add GITHUB_TOKEN, GITHUB_REPO, TEAM_PASSWORD and APPROVER_PASSWORD in Vercel → Settings → Environment Variables, then redeploy.' });
  }
  const pass = req.headers['x-kd-pass'] || '';
  const role = same(pass, APPROVER_PASSWORD) ? 'approver' : same(pass, TEAM_PASSWORD) ? 'team' : null;
  if (!role){ await sleep(700); return res.status(401).json({ message: 'Wrong password.' }); }

  let input = req.body || {};
  if (typeof input === 'string'){ try { input = JSON.parse(input); } catch (e){ input = {}; } }
  const { op, path = '', accept } = input;
  const method = String(input.method || 'GET').toUpperCase();
  let body = input.body;
  if (op === 'session') return res.status(200).json({ role, repo: GITHUB_REPO });

  if (!allowed(role, method, path)) return res.status(403).json({ message: 'You don’t have permission to do that.' });
  if (role === 'team' && method === 'POST' && body){
    body = { title: body.title, body: body.body, labels: ['keyword-request', 'pending-review'] };
  }

  try {
    const gh = await fetch(`${API}/repos/${GITHUB_REPO}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'keyword-desk',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    res.status(gh.status);
    res.setHeader('Content-Type', gh.headers.get('content-type') || 'application/octet-stream');
    res.send(Buffer.from(await gh.arrayBuffer()));
  } catch (e){
    res.status(502).json({ message: 'Couldn’t reach GitHub. Try again in a minute.' });
  }
};
