/**
 * API client — talks to the SemanticVCS Railway backend
 */

const https = require('https');
const http = require('http');

const API_BASE = 'https://semanticvcs-production.up.railway.app';
const API_KEY = 'svcs_XXxnDzU8GKd1BQ_T5AHO-DB8gfKXmtGuN4A2avbDs-s';

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    
    const headers = {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      'Authorization': `Bearer ${API_KEY}`,
    };
    
    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
      timeout: 60000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: { raw: data } });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function analyze(payload) {
  const res = await request('POST', '/api/v1/analyze', payload);
  return res.data;
}

async function getStats(repoId) {
  const res = await request('GET', `/api/v1/history/${encodeURIComponent(repoId)}/stats`);
  return res.data;
}

async function generateFix(payload) {
  const res = await request('POST', '/api/v1/generate-fix', payload);
  return res.data;
}

async function getBlastRadius(repoId, filePath) {
  const res = await request('GET', `/api/v1/blast-radius/${encodeURIComponent(repoId)}?file=${encodeURIComponent(filePath)}`);
  return res.data;
}

async function backfill(payload) {
  const res = await request('POST', '/api/v1/backfill', payload);
  if (res.status === 429) throw new Error('Rate limit exceeded');
  return res.data;
}

module.exports = { analyze, getStats, generateFix, getBlastRadius, backfill };
