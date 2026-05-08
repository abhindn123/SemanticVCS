/**
 * svcs status — git status + SemanticVCS dashboard
 */

const { execSync } = require('child_process');
const path = require('path');
const { c, box } = require('./ui');
const api = require('./api');

function getRepoId() {
  try {
    const remote = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
    const match = remote.match(/\/([^/]+?)(?:\.git)?$/);
    return match ? match[1] : path.basename(process.cwd());
  } catch {
    return path.basename(process.cwd());
  }
}

async function handleStatus(args) {
  // First show normal git status
  const { spawnSync } = require('child_process');
  spawnSync('git', ['status', ...args], { stdio: 'inherit', cwd: process.cwd(), shell: true });

  // Then show SemanticVCS stats
  const repoId = getRepoId();
  console.log('');

  try {
    const stats = await api.getStats(repoId);

    const high = stats.warnings_by_risk?.HIGH || 0;
    const medium = stats.warnings_by_risk?.MEDIUM || 0;
    const low = stats.warnings_by_risk?.LOW || 0;

    box(`🛡️  SemanticVCS — ${repoId}`, [
      '',
      `  ${c.dim}Commits Analyzed:${c.reset}  ${c.bold}${stats.total_commits_analyzed || 0}${c.reset}`,
      `  ${c.dim}Total Warnings:${c.reset}    ${c.bold}${stats.total_warnings || 0}${c.reset}`,
      '',
      `  ${c.red}● High Risk:${c.reset}       ${high}`,
      `  ${c.yellow}● Medium Risk:${c.reset}     ${medium}`,
      `  ${c.blue}● Low Risk:${c.reset}        ${low}`,
      '',
      `  ${c.dim}Engines:${c.reset}`,
      `  ${c.magenta}  🔮 Vector DB (Qdrant)${c.reset}    ${c.green}ACTIVE${c.reset}`,
      `  ${c.green}  🕸️  Knowledge Graph (Neo4j)${c.reset} ${c.green}ACTIVE${c.reset}`,
      '',
    ]);
  } catch (err) {
    console.log(`${c.dim}  SemanticVCS stats unavailable: ${err.message}${c.reset}`);
  }
}

module.exports = { handleStatus };
