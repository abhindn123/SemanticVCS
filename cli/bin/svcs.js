#!/usr/bin/env node

/**
 * svcs — SemanticVCS Git Wrapper
 * 
 * A drop-in replacement for git that adds AI-powered risk detection.
 * All commands pass through to git. "commit" gets superpowers.
 * 
 * Usage:
 *   svcs commit -m "message"    → git commit + risk analysis
 *   svcs status                 → git status + SemanticVCS dashboard
 *   svcs push origin main       → git push origin main (passthrough)
 *   svcs <anything>             → git <anything> (passthrough)
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');

// Load our commands
const { handleCommit } = require('../src/commit');
const { handleStatus } = require('../src/status');
const { handleBackfill } = require('../src/backfill');
const { passthrough } = require('../src/passthrough');
const { c } = require('../src/ui');

const args = process.argv.slice(2);
const command = args[0];

if (!command) {
  console.log(`
${c.bold}🛡️  svcs${c.reset} — SemanticVCS Git Wrapper

${c.dim}A drop-in replacement for git with AI-powered risk detection.${c.reset}

${c.bold}Usage:${c.reset}
  svcs commit -m "message"    Commit + analyze for risks
  svcs status                 Git status + SemanticVCS stats
  svcs backfill               Scan history & learn from reverts
  svcs init                   Initialize SemanticVCS in this repo
  svcs <any git command>      Passes through to git

${c.bold}Examples:${c.reset}
  svcs commit -m "simplified sanitizer"
  svcs push origin main
  svcs log --oneline -10

${c.dim}Powered by Qdrant (vector search) + Neo4j (knowledge graph) + Gemini (AI)${c.reset}
`);
  process.exit(0);
}

// Route to the right handler
(async () => {
  try {
    switch (command) {
      case 'commit':
        await handleCommit(args.slice(1));
        break;

      case 'status':
        await handleStatus(args.slice(1));
        break;

      case 'backfill':
        await handleBackfill();
        break;

      case 'init':
        console.log(`\n${c.green}✅ SemanticVCS initialized.${c.reset}`);
        console.log(`${c.dim}Every "svcs commit" will now be analyzed for risks.${c.reset}\n`);
        break;

      default:
        // Everything else passes through to git
        passthrough(args);
        break;
    }
  } catch (err) {
    console.error(`${c.red}Error: ${err.message}${c.reset}`);
    process.exit(1);
  }
})();
