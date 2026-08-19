#!/usr/bin/env node

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';
import { ROOT, pathsFor, renderSummary, saveFinalHtml } from './workflow.mjs';

const PORT = Number(process.env.WORKFLOW_PORT || process.argv[2] || 4173);
const SERVE_ROOT = process.env.WORKFLOW_ROOT ? resolve(process.env.WORKFLOW_ROOT) : ROOT;
const paths = pathsFor(SERVE_ROOT);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const ALLOWED_TOP_LEVEL = new Set(['data', 'output', 'reports', 'jds', 'documents']);

function safeStaticPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  const clean = normalize(decoded).replace(/^[/\\]+/, '');
  const segments = clean.split(/[\\/]+/).filter(Boolean);
  if (!segments.length || !ALLOWED_TOP_LEVEL.has(segments[0])) return null;
  if (segments.some(segment => segment === '.git' || segment === 'node_modules' || /^\.env(?:\.|$)/i.test(segment))) return null;
  const candidate = resolve(SERVE_ROOT, clean);
  const root = resolve(SERVE_ROOT);
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null;
}

async function bodyJson(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 5 * 1024 * 1024) throw new Error('Request body too large');
  }
  return JSON.parse(text || '{}');
}

function sendJson(response, status, value) {
  const text = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(text);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'POST' && request.url === '/__workflow/save') {
      const body = await bodyJson(request);
      const result = await saveFinalHtml(body.jobId, body.html, SERVE_ROOT);
      sendJson(response, 200, { ok: true, ...result });
      return;
    }
    if (request.method === 'GET' && request.url === '/__workflow/health') {
      sendJson(response, 200, { ok: true, root: SERVE_ROOT });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { ok: false, error: 'Method not allowed' });
      return;
    }
    const target = safeStaticPath(request.url === '/' ? '/output/workflow/index.html' : request.url);
    if (!target || !existsSync(target) || !(await stat(target)).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    const content = await readFile(target);
    response.writeHead(200, { 'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    if (request.method !== 'HEAD') response.end(content); else response.end();
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message });
  }
});

await renderSummary(SERVE_ROOT);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Career-Ops workflow server: http://127.0.0.1:${PORT}/`);
  console.log(`Summary: ${paths.summary}`);
});
