/**
 * svcs backfill — scan git history, send to backend for embedding
 * 
 * Replicates the VS Code extension's backfill logic in the terminal.
 */

const { execSync } = require('child_process');
const path = require('path');
const { c, box, spinner } = require('./ui');
const api = require('./api');

const MAX_COMMITS = 200;
const MAX_FILES_PER_COMMIT = 5;

const LANGUAGE_MAP = {
  '.py': 'python', '.js': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mjs': 'javascript',
  '.cjs': 'javascript', '.java': 'java', '.go': 'go', '.rs': 'rust',
};

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: process.cwd(), encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function getRepoId() {
  try {
    const remote = git('config --get remote.origin.url');
    const match = remote.match(/\/([^/]+?)(?:\.git)?$/);
    return match ? match[1] : path.basename(process.cwd());
  } catch {
    return path.basename(process.cwd());
  }
}

function getCommitLog() {
  const output = git(`log --format="%H|||%s|||%ae" --max-count=${MAX_COMMITS}`);
  return output.split(/\r?\n/).filter(l => l.length > 0).map(line => {
    const parts = line.split('|||');
    return { sha: (parts[0] || '').trim(), message: (parts[1] || '').trim(), author: (parts[2] || '').trim() };
  }).filter(c => c.sha.length > 0);
}

function getCommitDiffs(sha) {
  const diffs = [];
  try {
    const changedFiles = git(`diff-tree --root --no-commit-id --name-only -r ${sha}`)
      .split(/\r?\n/).map(f => f.trim()).filter(f => f.length > 0);

    for (const filePath of changedFiles) {
      if (diffs.length >= MAX_FILES_PER_COMMIT) break;
      const ext = path.extname(filePath);
      const language = LANGUAGE_MAP[ext];
      if (!language) continue;

      try {
        const diff = git(`diff ${sha}~1 ${sha} -- "${filePath}"`);
        let fileContent = git(`show ${sha}:"${filePath}"`);
        if (diff && fileContent) {
          const lines = fileContent.split('\n');
          if (lines.length > 500) fileContent = lines.slice(0, 500).join('\n');
          diffs.push({ file_path: filePath, language, diff, file_content: fileContent });
        }
      } catch {
        // Root commit fallback
        try {
          let fileContent = git(`show ${sha}:"${filePath}"`);
          if (fileContent) {
            const lines = fileContent.split('\n');
            if (lines.length > 500) fileContent = lines.slice(0, 500).join('\n');
            const fakeDiff = `@@ -0,0 +1,${lines.length} @@\n` + lines.map(l => `+${l}`).join('\n');
            diffs.push({ file_path: filePath, language, diff: fakeDiff, file_content: fileContent });
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return diffs;
}

async function handleBackfill() {
  const repoId = getRepoId();
  console.log(`\n${c.bold}🔄 SemanticVCS Backfill${c.reset} — ${c.dim}${repoId}${c.reset}\n`);

  // Get commit log
  const spin = spinner('Reading git history...');
  let commits;
  try {
    commits = getCommitLog();
  } catch (err) {
    spin.stop(`${c.red}❌ Failed to read git history: ${err.message}${c.reset}`);
    return;
  }

  if (commits.length === 0) {
    spin.stop(`${c.yellow}⚠️  No commits found${c.reset}`);
    return;
  }

  spin.stop(`${c.green}✅ Found ${commits.length} commits${c.reset}`);

  let totalProcessed = 0;
  let totalEmbedded = 0;
  let totalReverts = 0;

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    const progress = `[${i + 1}/${commits.length}]`;

    process.stdout.write(`\r${c.cyan}${progress}${c.reset} Processing ${c.dim}${commit.sha.slice(0, 7)}${c.reset} ${commit.message.slice(0, 40)}...`);

    const diffs = getCommitDiffs(commit.sha);
    if (diffs.length === 0) {
      process.stdout.write(` ${c.dim}(skip)${c.reset}\n`);
      continue;
    }

    process.stdout.write(` ${c.dim}${diffs.length} file(s)${c.reset}`);

    try {
      // The backend revert detection needs the full commit list to match "Revert <message>" to the original SHA
      const payloadCommits = commits.map(c => ({
        sha: c.sha,
        message: c.message,
        author: c.author,
        diffs: c.sha === commit.sha ? diffs : [],
      }));

      const result = await api.backfill({
        repo_id: repoId,
        commits: payloadCommits,
      });

      totalProcessed += result.commits_processed || 0;
      totalEmbedded += result.functions_embedded || 0;
      totalReverts += result.reverts_detected || 0;

      const info = result.commits_processed ? ` (${result.commits_processed}p/${result.functions_embedded}e/${result.reverts_detected}r)` : '';
      process.stdout.write(` ${c.green}✅${info}${c.reset}\n`);
    } catch (err) {
      process.stdout.write(` ${c.red}❌ ${err.message.slice(0, 50)}${c.reset}\n`);
      // Add delay on rate limit
      if (err.message.includes('Rate limit') || err.message.includes('429')) {
        console.log(`${c.yellow}   ⏳ Rate limited — waiting 10 seconds...${c.reset}`);
        await new Promise(r => setTimeout(r, 10000));
      }
    }

    // Small delay between requests to avoid rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('');
  box('✅ Backfill Complete', [
    '',
    `  ${c.dim}Commits processed:${c.reset}   ${c.bold}${totalProcessed}${c.reset}`,
    `  ${c.dim}Functions embedded:${c.reset}   ${c.bold}${totalEmbedded}${c.reset}`,
    `  ${c.dim}Reverts detected:${c.reset}    ${c.bold}${totalReverts}${c.reset}`,
    '',
  ], c.green);
  console.log('');
}

module.exports = { handleBackfill };
