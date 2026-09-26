#!/usr/bin/env node

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';
import { ROOT, deleteWorkflowJob, pathsFor, prepareEditable, renderPdf, renderSummary, renderWord, saveEditableHtml, saveProfile, saveWorkflowSettings } from './workflow.mjs';

const PORT = Number(process.env.WORKFLOW_PORT || process.argv[2] || 4173);
const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
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
    if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BODY_BYTES) {
      throw new Error(`Request body too large (max ${Math.round(MAX_REQUEST_BODY_BYTES / 1024 / 1024)} MB)`);
    }
  }
  return JSON.parse(text || '{}');
}

function sendJson(response, status, value) {
  const text = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' });
  response.end(text);
}

function chooseWindowsDirectory() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None',
    '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
    '$owner.Width = 1; $owner.Height = 1; $owner.Opacity = 0',
    '$owner.Show()',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = '选择简历导出文件夹'",
    '$dialog.ShowNewFolderButton = $true',
    'try { if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Write($dialog.SelectedPath); exit 0 }; exit 2 } finally { $dialog.Dispose(); $owner.Close(); $owner.Dispose() }',
  ].join('; ');
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', rejectPromise);
    child.once('close', code => {
      if (code === 2) return resolvePromise({ cancelled: true });
      if (code !== 0) return rejectPromise(new Error(stderr.trim() || `文件夹选择窗口退出，代码：${code}`));
      const path = stdout.trim();
      if (!path) return rejectPromise(new Error('未能读取所选文件夹路径'));
      resolvePromise({ cancelled: false, path });
    });
  });
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS' && ['/__workflow/save', '/__workflow/delete', '/__workflow/profile/save', '/__workflow/profile/export', '/__workflow/profile/import', '/__workflow/settings/save', '/__workflow/pick-directory'].includes(request.url)) {
      response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' });
      response.end();
      return;
    }
    if (request.method === 'POST' && request.url === '/__workflow/save') {
      const body = await bodyJson(request);
      const result = await saveEditableHtml(body.jobId, body.html, SERVE_ROOT);
      let word = null;
      let pdf = null;
      const warnings = [];
      try {
        word = await renderWord(body.jobId, SERVE_ROOT);
      } catch (error) {
        warnings.push(`Word 生成失败：${error.message}`);
      }
      try {
        pdf = await renderPdf(body.jobId, SERVE_ROOT);
      } catch (error) {
        warnings.push(`PDF 生成失败：${error.message}`);
      }
      try {
        await prepareEditable(body.jobId, SERVE_ROOT);
      } catch (error) {
        warnings.push(`编辑页面恢复失败：${error.message}`);
      }
      sendJson(response, 200, { ok: true, ...result, word: word?.path || null, pdf: pdf?.path || null, wordExportPath: word?.exportPath || null, pdfExportPath: pdf?.exportPath || null, warning: warnings.length ? warnings.join('；') : null });
      return;
    }
    if (request.method === 'POST' && request.url === '/__workflow/delete') {
      const body = await bodyJson(request);
      const result = await deleteWorkflowJob(body.jobId, SERVE_ROOT);
      sendJson(response, 200, { ok: true, ...result });
      return;
    }
    if (request.method === 'POST' && request.url === '/__workflow/profile/save') {
      const body = await bodyJson(request);
      const result = await saveProfile(body, SERVE_ROOT);
      sendJson(response, 200, { ok: true, ...result });
      return;
    }
    if (request.method === 'POST' && request.url === '/__workflow/profile/export') {
      const { exportProfile } = await import('./workflow.mjs');
      const profile = await exportProfile(SERVE_ROOT);
      sendJson(response, 200, { ok: true, profile });
      return;
    }
    if (request.method === 'POST' && request.url === '/__workflow/profile/import') {
      const { importProfile } = await import('./workflow.mjs');
      const body = await bodyJson(request);
      const result = await importProfile(body, SERVE_ROOT);
      sendJson(response, 200, { ok: true, ...result });
      return;
    }
    if (request.method === 'POST' && request.url === '/__workflow/settings/save') {
      try {
        const body = await bodyJson(request);
        const settings = await saveWorkflowSettings(body, SERVE_ROOT);
        sendJson(response, 200, { ok: true, settings });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
      }
      return;
    }
    if (request.method === 'POST' && request.url === '/__workflow/pick-directory') {
      try {
        const body = await bodyJson(request);
        if (!['pdfExportDir', 'wordExportDir'].includes(body.field)) throw new Error('无效的导出目录字段');
        if (process.platform !== 'win32') throw new Error('系统文件夹选择目前仅支持 Windows；也可以直接输入绝对路径');
        const selection = await chooseWindowsDirectory();
        sendJson(response, 200, { ok: true, ...selection });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
      }
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
    const requestPath = new URL(request.url, 'http://127.0.0.1').pathname;
    if ((request.method === 'GET' || request.method === 'HEAD') && requestPath === '/') {
      response.writeHead(302, { location: '/output/workflow/index.html' });
      response.end();
      return;
    }
    const target = safeStaticPath(request.url);
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
