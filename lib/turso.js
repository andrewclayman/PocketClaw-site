// Minimal libSQL/Turso client over the HTTP pipeline API — server-side counterpart to
// app/src/main/java/com/pocketclaw/data/TursoClient.kt. The admin URL + token live only here
// (Vercel env vars); the app never sees them.
const endpoint = () => {
  const raw = (process.env.TURSO_URL || '').trim().replace(/\/$/, '');
  if (!raw) throw new Error('TURSO_URL env var is not set');
  const https = raw.replace(/^libsql:\/\//, 'https://').replace(/^wss:\/\//, 'https://');
  return (https.startsWith('http') ? https : `https://${https}`) + '/v2/pipeline';
};

function token() {
  const t = process.env.TURSO_TOKEN;
  if (!t) throw new Error('TURSO_TOKEN env var is not set');
  return t;
}

// Args: ['text', v] | ['int64', v] | ['real', v] | ['null']
function argJson([kind, v]) {
  switch (kind) {
    case 'text': return { type: 'text', value: String(v) };
    // libSQL takes integers as STRINGS in the wire format.
    case 'int64': return { type: 'integer', value: String(v) };
    case 'real': return { type: 'float', value: v };
    default: return { type: 'null' };
  }
}
const T = (v) => ['text', v];
const I = (v) => ['int64', v];

/** Runs statements in order in one round trip. Returns rows per statement. */
async function execute(...statements) {
  const requests = statements.map(([sql, args = []]) => ({
    type: 'execute',
    stmt: { sql, args: args.map(argJson) },
  }));
  requests.push({ type: 'close' });

  const resp = await fetch(endpoint(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Turso HTTP ${resp.status}: ${text.slice(0, 400)}`);
  const results = JSON.parse(text).results || [];

  return results
    .map((r) => {
      if (r.type === 'error') throw new Error(`Turso SQL error: ${r.error?.message || 'unknown'}`);
      const result = r.response?.result;
      if (!result) return null; // the trailing "close" ack
      const cols = (result.cols || []).map((c) => c.name);
      return (result.rows || []).map((row) => {
        const obj = {};
        cols.forEach((name, i) => {
          const cell = row[i];
          obj[name] = cell.type === 'null' ? null : cell.value;
        });
        return obj;
      });
    })
    .filter((r) => r !== null);
}

async function query(sql, args = []) {
  const rows = await execute([sql, args]);
  return rows[0] || [];
}

module.exports = { query, execute, T, I };
