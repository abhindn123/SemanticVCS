/**
 * svcs commit — git commit with SemanticVCS analysis
 * 
 * Flow:
 * 1. Run git commit with all provided args
 * 2. Extract diff from the new commit
 * 3. Send to SemanticVCS backend for analysis
 * 4. If risks found → show interactive prompt
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const readline = require('readline');
const fs = require('fs');
const { c, box, spinner } = require('./ui');
const api = require('./api');

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: process.cwd(), encoding: 'utf-8' }).trim();
}

function getRepoId() {
  try {
    const remote = git('remote get-url origin');
    const match = remote.match(/\/([^/]+?)(?:\.git)?$/);
    return match ? match[1] : path.basename(process.cwd());
  } catch {
    return path.basename(process.cwd());
  }
}

function extractFunctions(diff, filePath) {
  const functions = [];
  const lines = diff.split('\n');
  
  // Strategy: use the @@ hunk header which contains the function name
  // Format: @@ -29,11 +29,14 @@ function renderProducts(filter = '') {
  // Also try to find function declarations in context or added lines
  
  let currentFuncName = null;
  let addedLines = [];
  let startLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check @@ header for function context
    const hunkMatch = line.match(/@@ .+? @@\s*(?:.*?(?:function\s+(\w+)|def\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=))?/);
    if (hunkMatch) {
      // Save previous function
      if (currentFuncName && addedLines.length > 0) {
        functions.push({
          name: currentFuncName,
          code: addedLines.join('\n'),
          start_line: startLine,
          end_line: i,
        });
      }
      currentFuncName = hunkMatch[1] || hunkMatch[2] || hunkMatch[3] || null;
      addedLines = [];
      const lineMatch = line.match(/@@ .+?\+(\d+)/);
      startLine = lineMatch ? parseInt(lineMatch[1]) : 0;
      continue;
    }

    // Check for function declaration in context or added lines
    const funcMatch = line.match(/^[+ ]\s*(?:async\s+)?(?:function\s+(\w+)|def\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\()/);
    if (funcMatch) {
      const name = funcMatch[1] || funcMatch[2] || funcMatch[3];
      if (name) currentFuncName = name;
    }

    // Collect added lines as the "changed code"
    if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLines.push(line.slice(1));
    }
  }

  // Save last function
  if (currentFuncName && addedLines.length > 0) {
    functions.push({
      name: currentFuncName,
      code: addedLines.join('\n'),
      start_line: startLine,
      end_line: lines.length,
    });
  }

  // If no functions found by name, use file-level changes
  if (functions.length === 0 && lines.some(l => l.startsWith('+'))) {
    const allAdded = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1));
    if (allAdded.length > 0) {
      functions.push({
        name: path.basename(filePath, path.extname(filePath)),
        code: allAdded.join('\n'),
        start_line: 1,
        end_line: allAdded.length,
      });
    }
  }

  return functions;
}

async function handleCommit(args) {
  // ① Run git commit
  console.log(`\n${c.dim}Running git commit...${c.reset}`);
  
  // Build the git commit command with proper quoting
  const commitArgs = args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ');
  try {
    execSync(`git commit ${commitArgs}`, { cwd: process.cwd(), stdio: 'inherit' });
  } catch (err) {
    process.exit(err.status || 1);
  }

  // ② Get commit info
  const sha = git('rev-parse HEAD');
  const message = git('log -1 --format=%s');
  const author = git('log -1 --format=%an');
  const repoId = getRepoId();

  console.log(`${c.green}✅ Committed:${c.reset} ${c.dim}${sha.slice(0, 7)}${c.reset} "${message}"\n`);

  // ③ Extract diff
  const spin = spinner('Analyzing commit for risks...');

  let diff;
  try {
    diff = git('diff HEAD~1 HEAD --unified=5');
  } catch {
    spin.stop(`${c.yellow}⚠️  Could not extract diff (first commit?)${c.reset}`);
    return;
  }

  if (!diff) {
    spin.stop(`${c.green}✅ No code changes to analyze${c.reset}`);
    return;
  }

  // Parse changed files
  const fileChunks = diff.split(/^diff --git /m).filter(Boolean);
  const diffs = [];

  for (const chunk of fileChunks) {
    const pathMatch = chunk.match(/a\/(.+?) b\//);
    if (!pathMatch) continue;

    const filePath = pathMatch[1];
    const ext = path.extname(filePath).slice(1);
    const supportedLangs = { js: 'javascript', ts: 'typescript', py: 'python', java: 'java', go: 'go', rs: 'rust', rb: 'ruby' };
    const language = supportedLangs[ext];
    if (!language) continue;

    // Get the full file content (what the backend needs for function extraction)
    let fileContent = '';
    try {
      fileContent = git(`show HEAD:"${filePath}"`);
    } catch {
      continue; // file deleted
    }

    diffs.push({
      file_path: filePath,
      language,
      diff: 'diff --git ' + chunk,
      file_content: fileContent,
    });
  }

  if (diffs.length === 0) {
    spin.stop(`${c.green}✅ No analyzable functions changed${c.reset}`);
    return;
  }

  // ④ Send to backend
  let result;
  try {
    result = await api.analyze({
      repo_id: repoId,
      commit_sha: sha,
      message,
      author,
      diffs,
    });
  } catch (err) {
    spin.stop(`${c.yellow}⚠️  Analysis unavailable: ${err.message}${c.reset}`);
    return;
  }

  const warnings = result.warnings || [];

  if (warnings.length === 0) {
    spin.stop(`${c.green}✅ No risks detected — commit is safe${c.reset}`);
    return;
  }

  // ⑤ Show warnings!
  spin.stop(`${c.red}🚨 ${warnings.length} risk(s) detected!${c.reset}\n`);

  for (const w of warnings) {
    const simPercent = Math.round((w.similarity_score || 0) * 100);
    const riskColor = w.risk_level === 'HIGH' ? c.red : w.risk_level === 'MEDIUM' ? c.yellow : c.blue;
    const commitShort = (w.matched_commit_sha || '').slice(0, 7);

    box(`${riskColor}${w.risk_level} RISK${c.reset} — ${c.bold}${w.function_name}${c.reset}`, [
      `${c.dim}File:${c.reset} ${w.file_path}:${w.start_line}-${w.end_line}`,
      `${c.dim}Similarity:${c.reset} ${simPercent}% match to reverted commit ${c.dim}${commitShort}${c.reset}`,
      '',
      `${c.dim}What happened before:${c.reset}`,
      `${w.historical_context || w.explanation || 'Similar code was previously reverted.'}`,
      '',
      `${c.dim}Gemini's analysis:${c.reset}`,
      `${w.explanation || 'This change resembles a previously problematic pattern.'}`,
      '',
      w.suggested_action ? `${c.dim}Suggested fix:${c.reset} ${w.suggested_action}` : '',
    ].filter(Boolean), riskColor);

    console.log('');

    // Interactive prompt
    console.log(`  ${c.cyan}[1]${c.reset} 🔄 Restore old version`);
    console.log(`  ${c.cyan}[2]${c.reset} 🤖 Fix with AI (Gemini)`);
    console.log(`  ${c.cyan}[3]${c.reset} ⚡ Continue anyway\n`);

    const choice = await prompt(`  ${c.bold}Choice (1/2/3):${c.reset} `);

    if (choice === '1') {
      // Restore old version
      try {
        execSync('git revert HEAD --no-edit', { cwd: process.cwd(), stdio: 'inherit' });
        console.log(`\n${c.green}✅ Reverted to safe version${c.reset}\n`);
      } catch (err) {
        console.log(`\n${c.red}❌ Revert failed: ${err.message}${c.reset}\n`);
      }
    } else if (choice === '2') {
      // AI fix
      const fixSpin = spinner('Gemini is generating a smart fix...');
      try {
        const currentCode = fs.readFileSync(path.resolve(process.cwd(), w.file_path), 'utf-8');
        const fixResult = await api.generateFix({
          bad_code: currentCode,
          safe_code: '',
          explanation: w.explanation || '',
          function_name: w.function_name || '',
          file_path: w.file_path,
          language: w.language || 'javascript',
        });

        if (fixResult.fixed_code) {
          fixSpin.stop(`${c.green}✅ AI fix generated!${c.reset}`);
          
          console.log(`\n${c.dim}Changes: ${(fixResult.changes_made || []).join(', ')}${c.reset}`);
          const apply = await prompt(`\n  ${c.bold}Apply this fix? (y/n):${c.reset} `);
          
          if (apply.toLowerCase() === 'y') {
            fs.writeFileSync(path.resolve(process.cwd(), w.file_path), fixResult.fixed_code, 'utf-8');
            execSync(`git add "${w.file_path}"`, { cwd: process.cwd() });
            execSync(`git commit -m "fix(ai): ${w.function_name} — Gemini-generated safe version (svcs)"`, { cwd: process.cwd() });
            console.log(`\n${c.green}✅ AI fix applied and committed!${c.reset}\n`);
          } else {
            console.log(`\n${c.dim}Fix discarded.${c.reset}\n`);
          }
        } else {
          fixSpin.stop(`${c.yellow}⚠️  AI fix generation failed${c.reset}`);
        }
      } catch (err) {
        fixSpin.stop(`${c.red}❌ AI fix failed: ${err.message}${c.reset}`);
      }
    } else {
      console.log(`\n${c.dim}Continuing with current commit.${c.reset}\n`);
    }
  }
}

module.exports = { handleCommit };
