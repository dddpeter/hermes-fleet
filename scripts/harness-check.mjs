#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const root = process.cwd()
const failures = []

function fail(message) {
  failures.push(message)
}

async function readText(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8')
}

function requireFile(relativePath) {
  if (!existsSync(path.join(root, relativePath))) {
    fail(`Missing required harness file: ${relativePath}`)
  }
}

function requireDir(relativePath) {
  if (!existsSync(path.join(root, relativePath))) {
    fail(`Missing required project directory: ${relativePath}`)
  }
}

function gitLines(args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function changedFilesFromGit() {
  const files = new Set()

  for (const file of gitLines(['diff', '--name-only'])) files.add(file)
  for (const file of gitLines(['diff', '--name-only', '--cached'])) files.add(file)
  for (const file of gitLines(['ls-files', '--others', '--exclude-standard'])) files.add(file)

  const baseRef = process.env.GITHUB_BASE_REF
  if (baseRef) {
    const baseCandidates = [`origin/${baseRef}`, baseRef]
    let foundPrBase = false
    for (const base of baseCandidates) {
      const diff = gitLines(['diff', '--name-only', `${base}...HEAD`])
      if (diff.length > 0) {
        foundPrBase = true
        for (const file of diff) files.add(file)
        break
      }
    }
    if (process.env.GITHUB_ACTIONS === 'true' && !foundPrBase && files.size === 0) {
      fail(`Unable to inspect PR diff against ${baseRef}; build checkout must fetch full history`)
    }
  } else {
    const upstream = gitLines(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])[0]
    if (upstream) {
      for (const file of gitLines(['diff', '--name-only', `${upstream}...HEAD`])) files.add(file)
    }
  }

  return [...files].sort()
}

function isChatSessionChainFile(file) {
  return file === 'packages/client/src/api/hermes/chat.ts'
    || file === 'packages/client/src/api/hermes/group-chat.ts'
    || file === 'packages/client/src/api/hermes/sessions.ts'
    || file === 'packages/client/src/stores/hermes/group-chat.ts'
    || file === 'packages/client/src/stores/hermes/chat.ts'
    || file === 'packages/server/src/controllers/hermes/sessions.ts'
    || file === 'packages/server/src/db/hermes/session-store.ts'
    || file === 'packages/server/src/routes/hermes/group-chat.ts'
    || file.startsWith('packages/client/src/components/hermes/group-chat/')
    || file.startsWith('packages/client/src/components/hermes/chat/')
    || file.startsWith('packages/server/src/lib/context-compressor/')
    || file.startsWith('packages/server/src/services/hermes/context-engine/')
    || file.startsWith('packages/server/src/services/hermes/group-chat/')
    || file.startsWith('packages/server/src/services/hermes/run-chat/')
    || file.startsWith('packages/server/src/services/hermes/agent-bridge/')
}

function isChatChainChangeFragment(file) {
  return file.startsWith('docs/chat-chain-changes/')
    && file.endsWith('.md')
    && path.basename(file) !== 'README.md'
}

for (const file of [
  'AGENTS.md',
  'ARCHITECTURE.md',
  'DEVELOPMENT.md',
  'docs/harness/README.md',
  'docs/harness/validation.md',
  'docs/harness/worktree-runbook.md',
  'docs/harness/pr-review.md',
  'docs/chat-chain-changes/README.md',
]) {
  requireFile(file)
}

for (const dir of [
  'packages/client/src',
  'packages/server/src',
  'tests/client',
  'tests/server',
  'tests/e2e',
  '.github/workflows',
  'docs/chat-chain-changes',
]) {
  requireDir(dir)
}

const agents = await readText('AGENTS.md')
const agentLines = agents.trimEnd().split(/\r?\n/)
if (agentLines.length > 120) {
  fail(`AGENTS.md should stay short; found ${agentLines.length} lines, expected <= 120`)
}

for (const requiredLink of [
  'DEVELOPMENT.md',
  'ARCHITECTURE.md',
  'docs/harness/README.md',
  'docs/harness/validation.md',
  'docs/harness/worktree-runbook.md',
  'docs/harness/pr-review.md',
]) {
  if (!agents.includes(requiredLink)) {
    fail(`AGENTS.md must link to ${requiredLink}`)
  }
}

const packageJson = JSON.parse(await readText('package.json'))
for (const scriptName of [
  'harness:check',
  'test',
  'test:coverage',
  'test:e2e',
  'build',
]) {
  if (!packageJson.scripts?.[scriptName]) {
    fail(`package.json is missing script: ${scriptName}`)
  }
}

const architecture = await readText('ARCHITECTURE.md')
for (const phrase of [
  'packages/client/src',
  'packages/server/src',
  'HERMES_WEB_UI_HOME',
]) {
  if (!architecture.includes(phrase)) {
    fail(`ARCHITECTURE.md should document: ${phrase}`)
  }
}

const buildWorkflow = await readText('.github/workflows/build.yml')
if (!buildWorkflow.includes('npm run harness:check')) {
  fail('Build workflow must run npm run harness:check')
}
if (!buildWorkflow.includes('fetch-depth: 0')) {
  fail('Build workflow checkout must use fetch-depth: 0 so harness:check can inspect PR diffs')
}

const chatSessionsDoc = await readText('docs/cli-chat-sessions.md')
for (const phrase of [
  '最后重建时间',
  '维护要求',
  '最近链路变更记录',
  'docs/chat-chain-changes/',
  '每个 PR 一个变更片段',
  'packages/server/src/services/hermes/agent-bridge/',
  'packages/server/src/services/hermes/group-chat/',
  'packages/server/src/lib/context-compressor/',
  '任何改动都算 Chat 链路改动',
]) {
  if (!chatSessionsDoc.includes(phrase)) {
    fail(`docs/cli-chat-sessions.md must document chat chain maintenance rule: ${phrase}`)
  }
}

const changedFiles = changedFilesFromGit()
const changedChatChainFiles = changedFiles.filter(
  file => !isChatChainChangeFragment(file)
    && file !== 'docs/chat-chain-changes/README.md'
    && file !== 'docs/cli-chat-sessions.md'
    && isChatSessionChainFile(file),
)
const changedChatChainFragments = changedFiles.filter(isChatChainChangeFragment)
if (changedChatChainFiles.length > 0 && changedChatChainFragments.length === 0) {
  fail(
    [
      'Chat session chain changed without adding a docs/chat-chain-changes/*.md fragment.',
      'Add one fragment with date, PR/commit, touched feature, and behavior impact.',
      `Changed chain files: ${changedChatChainFiles.join(', ')}`,
    ].join(' '),
  )
}
for (const file of changedChatChainFragments) {
  if (!existsSync(path.join(root, file))) {
    fail(`Chat chain change fragment was removed instead of added/updated: ${file}`)
    continue
  }
  const fragment = await readText(file)
  for (const marker of ['date:', 'feature:', 'impact:']) {
    if (!fragment.includes(marker)) {
      fail(`Chat chain change fragment ${file} must include frontmatter field: ${marker}`)
    }
  }
  if (!fragment.includes('pr:') && !fragment.includes('commit:')) {
    fail(`Chat chain change fragment ${file} must include either pr: or commit:`)
  }
}

const webuiReleaseWorkflow = await readText('.github/workflows/webui-release.yml')

if (!webuiReleaseWorkflow.includes('release:') || !webuiReleaseWorkflow.includes('types: [published]')) {
  fail('webui-release.yml must keep running on published GitHub Releases')
}
if (!webuiReleaseWorkflow.includes('gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --latest=false')) {
  fail('webui-release.yml must keep published GitHub Releases out of latest')
}

if (!webuiReleaseWorkflow.includes('make_latest: false')) {
  fail('webui-release.yml must not mark release uploads as GitHub latest')
}

if (failures.length > 0) {
  console.error('Harness check failed:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log('Harness check passed')
