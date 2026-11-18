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

// Everything the page needs at start, fetched in parallel in one trip.
async function loadEverything(token, repo){
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'keyword-desk' };
  const get = p => fetch(`${API}/repos/${repo}${p}`, { headers });
  async function file(name){
    const r = await get('/contents/' + encodeURIComponent(name));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub said ${r.status} for ${name}`);
    const j = await r.json();
    let text = j.content ? Buffer.from(j.content, 'base64').toString('utf8') : null;
    if (text === null){
      const raw = await fetch(`${API}/repos/${repo}/contents/${encodeURIComponent(name)}`, { headers: { ...headers, Accept: 'application/vnd.github.raw+json' } });
      text = await raw.text();
    }
    return { text, sha: j.sha };
  }
  async function issues(){
    const out = [];
    for (let page = 1; page <= 5; page++){
      const r = await get(`/issues?labels=keyword-request&state=all&per_page=100&page=${page}`);
      if (!r.ok) throw new Error(`GitHub said ${r.status} for issues`);
      const batch = await r.json();
      for (const i of batch){
        if (i.pull_request) continue;
        out.push({ number: i.number, html_url: i.html_url, title: i.title, body: i.body, state: i.state, created_at: i.created_at,
          labels: (i.labels || []).map(l => ({ name: l.name })), user: { login: i.user && i.user.login } });
      }
      if (batch.length < 100) break;
    }
    return out;
  }
  const names = ['current.txt', 'release.json', 'keyword-config.json', 'releases.json'];
  const [list, ...contents] = await Promise.all([issues(), ...names.map(file)]);
  const files = {}; names.forEach((n, i) => { files[n] = contents[i]; });
  return { files, issues: list };
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
  if (op === 'load'){
    try { return res.status(200).json({ role, repo: GITHUB_REPO, ...(await loadEverything(GITHUB_TOKEN, GITHUB_REPO)) }); }
    catch (e){ return res.status(502).json({ message: e.message || 'Couldn’t reach GitHub.' }); }
  }

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
