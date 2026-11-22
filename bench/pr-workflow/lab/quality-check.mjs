// Trusted base-branch check of the candidate file at one exact PR head.
// This rule covers the toy login page, not arbitrary HTML security.
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const isSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value)

export function assessLabCandidate({ expectedSha, checkoutSha, currentSha, changedPaths, regularFile, html }) {
  const headSha = isSha(expectedSha) ? expectedSha : null
  if (!headSha) return { allow: false, reason: 'invalid-head-sha', headSha }
  if (!isSha(checkoutSha) || checkoutSha !== headSha) {
    return { allow: false, reason: 'checkout-head-mismatch', headSha }
  }
  if (!isSha(currentSha) || currentSha !== headSha) {
    return { allow: false, reason: 'pr-head-changed', headSha }
  }
  if (!Array.isArray(changedPaths) || changedPaths.length !== 1 || changedPaths[0] !== 'login.html') {
    return { allow: false, reason: 'unexpected-files', headSha }
  }
  if (regularFile !== true || typeof html !== 'string' || html.length === 0 || html.length > 65_536 ||
    !html.includes('<main class="login">Synthetic page for PR review.</main>')) {
    return { allow: false, reason: 'invalid-lab-page', headSha }
  }
  if (/<\s*\/?\s*(?:script|iframe|object|embed|svg|math)\b|\bon[a-z]+\s*=|javascript\s*:|\bsrcdoc\s*=|\binnerHTML\b/iu.test(html)) {
    return { allow: false, reason: 'executable-markup', headSha }
  }
  return { allow: true, reason: 'clean-lab-markup', headSha }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const candidate = process.env.PR_CANDIDATE_DIR
    if (!candidate) throw new Error('PR_CANDIDATE_DIR is required')
    const checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: candidate, encoding: 'utf8', timeout: 10_000,
    }).trim()
    const baseSha = process.env.PR_BASE_SHA
    if (!isSha(baseSha) || !isSha(checkoutSha)) throw new Error('valid base and checkout SHAs are required')
    const changedPaths = execFileSync('git', ['diff', '--name-only', '--no-ext-diff',
      `${baseSha}...${checkoutSha}`], {
      cwd: candidate, encoding: 'utf8', timeout: 10_000,
    }).trim().split('\n').filter(Boolean)
    const page = join(candidate, 'login.html')
    const regularFile = lstatSync(page).isFile()
    const html = regularFile ? readFileSync(page, 'utf8') : ''
    const verdict = assessLabCandidate({
      expectedSha: process.env.PR_EXPECTED_SHA,
      currentSha: process.env.PR_CURRENT_SHA,
      checkoutSha,
      changedPaths,
      regularFile,
      html,
    })
    process.stdout.write(JSON.stringify(verdict) + '\n')
    if (!verdict.allow) process.exitCode = 1
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'quality check failed') + '\n')
    process.exitCode = 1
  }
}
