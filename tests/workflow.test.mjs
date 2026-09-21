// Workflow workspace tests. These stay hermetic by using a temporary root and
// exercise the file contracts without requiring an LLM, a live job board, or a
// browser session.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pass, fail } from './helpers.mjs';
import {
  cleanEditableHtml,
  deleteWorkflowJob,
  editableInjection,
  ensureWorkspace,
  ingest,
  inspectProfile,
  pathsFor,
  renderSummary,
  renderWord,
  resumeFileName,
  passesResumeGate,
  saveFinalHtml,
} from '../workflow.mjs';

console.log('\nworkflow.mjs - workspace and artifact contracts');

function check(label, condition, detail = '') {
  if (condition) pass(label);
  else fail(`${label}${detail ? ` (${detail})` : ''}`);
}

const root = await mkdtemp(join(tmpdir(), 'career-ops-workflow-'));
try {
  const paths = await ensureWorkspace(root);
  check('workspace creates candidate input directories', existsSync(paths.input) && existsSync(paths.personalInfoDir) && existsSync(paths.inbox) && existsSync(paths.photos));
  check('workspace creates a local personal info file', existsSync(paths.personalInfoFile));
  writeFileSync(paths.jobsFile, [
    '# comments are ignored',
    'job-alpha | https://example.com/jobs/alpha',
    'JOB-ALPHA | https://example.com/jobs/alpha',
    'https://example.com/jobs/beta',
  ].join('\n') + '\n');
  writeFileSync(join(paths.inbox, 'job-alpha.md'), '# Alpha JD\nPython Linux Docker');
  writeFileSync(join(paths.inbox, 'job-alpha-screenshot.png'), 'fake-image');
  writeFileSync(join(paths.inbox, 'unlisted.txt'), '# Unlisted JD');
  writeFileSync(join(paths.inbox, 'README.md'), '# Input directory instructions');

  const index = await ingest(root);
  check('ingest deduplicates repeated job URLs', index.jobs.filter(job => job.url?.endsWith('/alpha')).length === 1);
  check('ingest preserves explicit job IDs', index.jobs.some(job => job.id === 'job-alpha'));
  check('ingest groups attachments by job ID', index.jobs.find(job => job.id === 'job-alpha')?.attachments?.length === 2);
  check('ingest keeps attachment-only jobs', index.jobs.some(job => job.id === 'unlisted'));
  check('ingest ignores the input directory README', !index.jobs.some(job => job.id === 'README'));

  const reportPath = join(root, 'reports', '001-alpha.md');
  mkdirSync(join(root, 'reports'), { recursive: true });
  writeFileSync(reportPath, '# Alpha report');
  const record = {
    version: 1,
    id: 'job-alpha',
    company: 'Alpha',
    role: '运维工程师',
    url: 'https://example.com/jobs/alpha',
    jdPath: 'jds/job-alpha.md',
    attachments: [{ name: 'job-alpha.md', path: 'jds/job-alpha.md' }],
    reportPath: 'reports/001-alpha.md',
    score: 4.2,
    recommendation: '建议申请',
    skillsMatched: ['Python', 'Linux'],
    skillGaps: ['Kubernetes'],
    resumeAdvice: {
      summary: '突出 Linux 部署与网络排障。',
      experience: ['将交付经历放在顶部。'],
      projects: ['优先展示安全分析平台。'],
      keywords: ['incident response'],
      avoid: ['不要把了解写成精通。'],
    },
    artifacts: {},
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(paths.records, 'job-alpha.json'), JSON.stringify(record, null, 2));
  const summary = await renderSummary(root);
  const summaryHtml = readFileSync(summary.path, 'utf8');
  check('summary accumulates evaluated records', summary.count === 3 && summaryHtml.includes('Alpha'));
  check('summary exposes existing report links', summaryHtml.includes('reports/001-alpha.md'));
  check('summary shows concrete resume advice', summaryHtml.includes('incident response') && summaryHtml.includes('查看具体修改建议'));
  check('summary exposes PDF status filter', summaryHtml.includes('id="pdf"') && summaryHtml.includes('PDF 未确定'));
  check('summary defaults to newest-first time sorting', summaryHtml.includes('id="sort"><option value="time-desc">最近更新（默认）</option>') && summaryHtml.includes('data-time="'));
  check('summary marks jobs without PDFs as pending', summaryHtml.includes('data-pdf="pending"'));
  check('summary exposes a delete action', summaryHtml.includes('class="link danger delete-job"'));
  check('summary disables missing local artifacts', summaryHtml.includes('class="link disabled">自动简历</span>'));

  const profileBefore = await inspectProfile(root);
  check('profile gate reports missing formal profile files', !profileBefore.ready && profileBefore.missing.includes('config') && profileBefore.missing.includes('mode'));
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'modes'), { recursive: true });
  writeFileSync(join(root, 'cv.md'), '# CV\n\n## Professional Summary\nCandidate\n\n## Core Skills\nPython\n\n## Work Experience\nNone\n');
  writeFileSync(join(root, 'config', 'profile.yml'), 'language:\n  output: zh-CN\n');
  writeFileSync(join(root, 'modes', '_profile.md'), '# Profile\n');
  const profileAfter = await inspectProfile(root);
  check('profile gate becomes ready only when all profile files exist', profileAfter.ready);

  const editable = '<!doctype html><html><head><style id="workflow-editor-style">editor</style></head><body><div class="page workflow-edit-target" contenteditable="true">CV</div><div id="workflow-toolbar" class="workflow-toolbar" contenteditable="false">toolbar</div><script data-workflow-editor="true">alert(1)</script></body></html>';
  const cleaned = cleanEditableHtml(editable);
  check('final HTML cleaning removes editor toolbar', !cleaned.includes('workflow-toolbar'));
  check('final HTML cleaning removes workflow script and attributes', !cleaned.includes('workflow-editor') && !cleaned.includes('contenteditable'));
  check('final HTML cleaning preserves resume content', cleaned.includes('>CV<'));
  const injected = editableInjection('<html><body><main class="page">CV</main></body></html>', 'job-alpha');
  check('editable HTML supports local-file save fallback', injected.includes("location.protocol==='file:'") && injected.includes('http://127.0.0.1:4173/__workflow/save'));
  check('editable HTML reports save failures', injected.includes('button.disabled=true') && injected.includes('保存失败'));
  check('editable HTML reports Word and PDF generation', injected.includes('保存并生成 Word/PDF') && injected.includes('Word/PDF 已生成'));
  check('resume filename uses company and detected role', resumeFileName(record) === 'Alpha-运维工程师');
  check('resume gate accepts scores above three only', passesResumeGate(3.1) && !passesResumeGate(3) && !passesResumeGate(2.9));

  const first = await saveFinalHtml('job-alpha', editable, root);
  const second = await saveFinalHtml('job-alpha', editable.replace('CV', 'CV v2'), root);
  check('first confirmed HTML uses the company-role filename', first.path.endsWith('/job-alpha/Alpha-运维工程师.html'));
  check('second confirmed HTML overwrites the stable final path', second.path.endsWith('/job-alpha/Alpha-运维工程师.html'));
  const photoSizedHtml = '<!doctype html><html><body><div class="page">' + 'x'.repeat(5 * 1024 * 1024) + '</div></body></html>';
  const photoSizedSave = await saveFinalHtml('job-alpha', photoSizedHtml, root);
  check('confirmed HTML accepts photo-sized payloads', photoSizedSave.path.endsWith('/job-alpha/Alpha-运维工程师.html'));
  check('stable final HTML is overwritten in place', existsSync(join(root, 'output', 'workflow', 'job-alpha', 'Alpha-运维工程师.html')));
  check('saved final HTML contains no workflow editor residue', !readFileSync(join(root, 'output', 'workflow', 'job-alpha', 'Alpha-运维工程师.html'), 'utf8').includes('workflow-'));
  const word = await renderWord('job-alpha', root);
  check('Word artifact is generated from the confirmed final HTML', word.path.endsWith('/job-alpha/Alpha-运维工程师.docx') && existsSync(join(root, 'output', 'workflow', 'job-alpha', 'Alpha-运维工程师.docx')));
  const wordSummary = await renderSummary(root);
  check('summary exposes the Word artifact link', readFileSync(wordSummary.path, 'utf8').includes('>Word</a>'));

  const deleteResult = await deleteWorkflowJob('job-alpha', root);
  const afterDelete = readFileSync(paths.summary, 'utf8');
  const jobsAfterDelete = JSON.parse(readFileSync(paths.jobsIndex, 'utf8'));
  const jobsTextAfterDelete = readFileSync(paths.jobsFile, 'utf8');
  check('delete removes the workflow record', deleteResult.removed.record && !existsSync(join(paths.records, 'job-alpha.json')));
  check('delete removes generated output', deleteResult.removed.output && !existsSync(join(paths.output, 'job-alpha')));
  check('delete removes the report', deleteResult.removed.report && !existsSync(reportPath));
  check('delete removes the job attachments', deleteResult.removed.attachments === 2 && !existsSync(join(paths.inbox, 'job-alpha.md')) && !existsSync(join(paths.inbox, 'job-alpha-screenshot.png')));
  check('delete removes all matching job URL lines', deleteResult.removed.jobUrl && !jobsTextAfterDelete.includes('https://example.com/jobs/alpha'));
  check('delete preserves other jobs and refreshes summary', jobsAfterDelete.jobs.some(job => job.url?.endsWith('/beta')) && jobsAfterDelete.jobs.some(job => job.id === 'unlisted') && !afterDelete.includes('Alpha'));
} catch (error) {
  fail(`workflow fixture crashed: ${error.message}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
