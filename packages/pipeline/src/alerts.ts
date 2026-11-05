import fs from 'node:fs';
import { log } from './config.js';

/**
 * Failure alerts. Three channels, all optional, all best-effort:
 *  1. GitHub Actions step summary ($GITHUB_STEP_SUMMARY) – always visible on the run page
 *  2. Webhook (ALERT_WEBHOOK_URL) – Slack / Discord compatible payload
 *  3. GitHub issue upsert (GITHUB_TOKEN + GITHUB_REPOSITORY in Actions) – one open issue per week, updated in place
 * The calling command also exits non-zero on an incomplete batch so Actions sends its own failure e-mail.
 */
export async function alert(level: 'info' | 'warn' | 'error', title: string, markdown: string, opts: { issueKey?: string } = {}): Promise<void> {
  const line = `${level === 'error' ? '🚨' : level === 'warn' ? '⚠️' : 'ℹ️'} ${title}`;
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${line}\n\n${markdown}\n\n`); } catch { /* ignore */ }
  }
  const hook = process.env.ALERT_WEBHOOK_URL;
  if (hook) {
    try {
      const text = `${line}\n${markdown.slice(0, 3500)}`;
      await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text.slice(0, 1900) }) });
    } catch (e) { log.warn(`alert webhook failed: ${(e as Error).message}`); }
  }
  if (level !== 'info' && opts.issueKey && process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
    await upsertIssue(`[toaster] ${opts.issueKey}`, `${line}\n\n${markdown}`).catch((e) => log.warn(`issue upsert failed: ${(e as Error).message}`));
  }
  (level === 'error' ? log.error : level === 'warn' ? log.warn : log.info)(title);
}

async function upsertIssue(title: string, body: string): Promise<void> {
  const repo = process.env.GITHUB_REPOSITORY!;
  const headers = { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'toaster-pipeline' };
  const list = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&labels=toaster-alert&per_page=50`, { headers });
  if (!list.ok) throw new Error(`list issues ${list.status}`);
  const issues = (await list.json()) as { number: number; title: string }[];
  const existing = issues.find((i) => i.title === title);
  const footer = `\n\n_Updated ${new Date().toISOString()} by the pipeline._`;
  if (existing) {
    await fetch(`https://api.github.com/repos/${repo}/issues/${existing.number}`, { method: 'PATCH', headers, body: JSON.stringify({ body: body + footer }) });
  } else {
    await fetch(`https://api.github.com/repos/${repo}/issues`, { method: 'POST', headers, body: JSON.stringify({ title, body: body + footer, labels: ['toaster-alert'] }) });
  }
}
