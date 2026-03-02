#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > 0) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    out[token.slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

async function runCommand(command, args, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = 0,
    stdoutFile = '',
    stderrFile = '',
  } = options;

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];
    let timeoutHandle = null;
    let settled = false;

    if (stdoutFile) ensureDir(path.dirname(stdoutFile));
    if (stderrFile) ensureDir(path.dirname(stderrFile));

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(chunk);
      if (stdoutFile) fs.appendFileSync(stdoutFile, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk);
      if (stderrFile) fs.appendFileSync(stderrFile, chunk);
    });

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`Command timeout after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
      }, timeoutMs);
    }

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        const error = new Error(`Command failed (${code}): ${command} ${args.join(' ')}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function extractTailFromSessionFile(sessionFilePath, sessionId) {
  if (!fs.existsSync(sessionFilePath)) {
    throw new Error(`Session file not found: ${sessionFilePath}`);
  }
  const lines = fs.readFileSync(sessionFilePath, 'utf8').split('\n').filter(Boolean);
  let matched = null;
  for (const line of lines) {
    const row = safeJsonParse(line);
    const message = row?.message;
    if (!message || message.role !== 'toolResult') continue;
    if (message.toolName !== 'process') continue;
    const details = message.details && typeof message.details === 'object' ? message.details : {};
    if (String(details.sessionId || '') !== sessionId) continue;
    const aggregated = typeof details.aggregated === 'string' ? details.aggregated : '';
    const textPayload = Array.isArray(message.content)
      ? message.content.find((part) => part && part.type === 'text' && typeof part.text === 'string')?.text || ''
      : '';
    const candidate = aggregated || textPayload;
    if (!candidate) continue;
    if (!candidate.includes('[1C') && !candidate.includes('[?2026h')) continue;
    matched = candidate;
  }
  if (!matched) {
    throw new Error(`No matching process toolResult with ANSI fragments for sessionId=${sessionId}`);
  }
  return matched;
}

async function emitGatewayEvent(page, frame) {
  return await page.evaluate(
    (payload) => window.__TGCLAW_E2E__?.emitGatewayEvent?.(payload) === true,
    frame,
  );
}

async function setTerminalSessionSupport(page, enabled) {
  return await page.evaluate(
    (value) => window.__TGCLAW_E2E_CHAT__?.setTerminalSessionSupport?.(value) === true,
    enabled,
  );
}

async function getSnapshot(page) {
  return await page.evaluate(() => window.__TGCLAW_E2E__?.snapshot?.() || null);
}

async function getTabText(page, projectId, tabId) {
  return await page.evaluate(
    ({ p, t }) => window.__TGCLAW_E2E__?.getTabText?.(p, t) || '',
    { p: projectId, t: tabId },
  );
}

async function waitUntil(predicate, timeoutMs, intervalMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function buildIsolatedConfig(repoRoot) {
  const projectBPath = fs.existsSync(path.join(repoRoot, 'thirdparty', 'openclaw'))
    ? path.join(repoRoot, 'thirdparty', 'openclaw')
    : repoRoot;
  return {
    projects: [
      { id: 'proj-a', name: 'ANSI Repro A', cwd: repoRoot },
      { id: 'proj-b', name: 'ANSI Repro B', cwd: projectBPath },
    ],
    gatewayConfig: {
      url: '',
      token: '',
      configured: false,
    },
    gateway: {
      url: '',
      token: '',
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const scenario = String(args.scenario || 'ansi-legacy').trim().toLowerCase();
  const validScenarios = new Set([
    'ansi-legacy',
    'start-only',
    'terminal-session',
    'terminal-session-race',
  ]);
  if (!validScenarios.has(scenario)) {
    throw new Error(`Unsupported scenario: ${scenario}`);
  }
  const defaultSessionFile = path.join(
    os.homedir(),
    '.openclaw',
    'agents',
    'main',
    'sessions',
    '844374b8-25fe-4fa3-814f-a97cbcbce4db.jsonl',
  );
  const sessionFile = String(args['session-file'] || defaultSessionFile);
  const sessionId = String(args['session-id'] || 'marine-canyon');
  const stamp = nowStamp();
  const artifactsDir = path.join(repoRoot, 'output', 'e2e', `openclaw-ansi-repro-${stamp}`);
  const logsDir = path.join(artifactsDir, 'logs');
  const screenshotsDir = path.join(artifactsDir, 'screenshots');
  const tgclawDir = path.join(artifactsDir, 'tgclaw');
  const userDataDir = path.join(tgclawDir, 'user-data');
  ensureDir(logsDir);
  ensureDir(screenshotsDir);
  ensureDir(userDataDir);

  const report = {
    startedAt: new Date().toISOString(),
    artifactsDir,
    sessionFile,
    sessionId,
    scenario,
    checks: [],
  };

  let app = null;
  try {
    let tail = '';
    if (scenario === 'ansi-legacy') {
      tail = extractTailFromSessionFile(sessionFile, sessionId);
      report.tailBytes = Buffer.byteLength(tail, 'utf8');
      report.checks.push({ name: 'tail_loaded_from_real_session', passed: true });
    }

    writeJson(path.join(userDataDir, 'config.json'), buildIsolatedConfig(repoRoot));
    report.checks.push({ name: 'isolated_tgclaw_config_written', passed: true });

    await runCommand('npm', ['run', 'build:renderer'], {
      cwd: repoRoot,
      timeoutMs: 180000,
      stdoutFile: path.join(logsDir, 'build-renderer.out.log'),
      stderrFile: path.join(logsDir, 'build-renderer.err.log'),
    });
    report.checks.push({ name: 'renderer_built', passed: true });

    const electronBinary = require('electron');
    app = await electron.launch({
      executablePath: electronBinary,
      args: [repoRoot],
      env: {
        ...process.env,
        TGCLAW_USER_DATA_DIR: userDataDir,
        TGCLAW_E2E: '1',
      },
    });
    const page = await app.firstWindow();
    await page.waitForSelector('#chat-input', { timeout: 30000 });
    await page.screenshot({ path: path.join(screenshotsDir, '01-initial.png') });
    report.checks.push({ name: 'electron_started', passed: true });

    if (scenario === 'terminal-session' || scenario === 'terminal-session-race') {
      const supportEnabled = await setTerminalSessionSupport(page, true);
      if (!supportEnabled) {
        throw new Error('Failed enabling terminal-session support in e2e chat bridge.');
      }
      report.checks.push({ name: 'terminal_session_mode_enabled', passed: true });
    }

    await page.click('[data-project-id="proj-a"]');
    await page.click('.sidebar-item.pinned[data-id="openclaw"]');

    const toolCallId = `ansi-repro-${Date.now()}`;
    const submitProbe = `submit-probe-${toolCallId}`;
    const frames = [
      {
        event: 'agent',
        payload: {
          stream: 'tool',
          data: {
            phase: 'start',
            name: 'exec',
            toolCallId,
            args: {
              command: 'claude exec "hello"',
              workdir: repoRoot,
              pty: true,
            },
          },
        },
      },
    ];
    if (scenario === 'start-only') {
      frames.push({
        event: 'agent',
        payload: {
          stream: 'tool',
          data: {
            phase: 'start',
            name: 'process',
            args: {
              action: 'submit',
              sessionId,
              data: submitProbe,
            },
          },
        },
      });
    } else if (scenario === 'terminal-session') {
      frames.push(
        {
          event: 'terminal.session.output',
          payload: {
            sessionId,
            stream: 'stdout',
            data: `Claude Code v2.1.59\r\nWelcome to Opus 4.6\r\n`,
            cursor: 64,
          },
        },
        {
          event: 'terminal.session.input',
          payload: {
            sessionId,
            data: 'agent-input-marker\r',
            actor: 'agent',
            ts: Date.now(),
          },
        },
        {
          event: 'terminal.session.output',
          payload: {
            sessionId,
            stream: 'stdout',
            data: `${repoRoot}\r\n`,
            cursor: 80,
          },
        },
        {
          event: 'terminal.session.exit',
          payload: {
            sessionId,
            status: 'completed',
            exitCode: 0,
          },
        },
      );
    } else if (scenario === 'terminal-session-race') {
      frames.push(
        {
          event: 'agent',
          payload: {
            stream: 'tool',
            data: {
              phase: 'start',
              name: 'process',
              args: {
                action: 'submit',
                sessionId,
                data: submitProbe,
              },
            },
          },
        },
        {
          event: 'terminal.session.output',
          payload: {
            sessionId,
            stream: 'stdout',
            data: 'Claude Code v2.1.59\r\nWelcome to Opus 4.6\r\n',
            cursor: 64,
          },
        },
        {
          event: 'terminal.session.exit',
          payload: {
            sessionId,
            status: 'completed',
            exitCode: 0,
          },
        },
      );
    } else {
      frames.push(
        {
          event: 'agent',
          payload: {
            stream: 'tool',
            data: {
              phase: 'start',
              name: 'process',
              args: {
                action: 'send-keys',
                sessionId,
                keys: ['ENTER'],
              },
            },
          },
        },
        {
          event: 'agent',
          payload: {
            stream: 'tool',
            data: {
              phase: 'start',
              name: 'process',
              args: {
                action: 'send-keys',
                sessionId,
                literal: '1',
              },
            },
          },
        },
        {
          event: 'agent',
          payload: {
            stream: 'tool',
            data: {
              phase: 'update',
              name: 'exec',
              toolCallId,
              partialResult: {
                details: {
                  sessionId,
                  tail,
                },
              },
            },
          },
        },
        {
          event: 'agent',
          payload: {
            stream: 'tool',
            data: {
              phase: 'result',
              name: 'exec',
              toolCallId,
              result: {
                details: {
                  sessionId,
                  status: 'failed',
                  exitCode: 143,
                },
                content: [
                  {
                    type: 'text',
                    text: tail,
                  },
                ],
              },
            },
          },
        },
      );
    }

    if (scenario === 'terminal-session' || scenario === 'terminal-session-race') {
      const supportEnabled = await setTerminalSessionSupport(page, true);
      if (!supportEnabled) {
        throw new Error('Failed re-enabling terminal-session support before frame injection.');
      }
    }

    for (const frame of frames) {
      const ok = await emitGatewayEvent(page, frame);
      if (!ok) throw new Error('Failed injecting gateway frame via e2e bridge.');
      await sleep(120);
    }
    report.checks.push({
      name: 'gateway_frames_injected',
      passed: true,
      details: { count: frames.length, toolCallId },
    });

    const snap = await waitUntil(async () => {
      const current = await getSnapshot(page);
      const tabs = current?.tabsByProject?.['proj-a'] || [];
      if (tabs.length === 0) return null;
      return current;
    }, 30000, 500, 'openclaw virtual tab');

    const tab = (snap.tabsByProject['proj-a'] || []).find((item) => item.type === 'claude-code')
      || (snap.tabsByProject['proj-a'] || [])[0];
    if (!tab) throw new Error('No tab found after frame injection.');

    await page.click('[data-project-id="proj-a"]');
    await page.click(`.tab[data-tab-id="${tab.id}"]`);
    await sleep(scenario === 'start-only' ? 2200 : 1200);
    const tabText = await getTabText(page, 'proj-a', tab.id);
    const textPath = path.join(logsDir, 'virtual-tab-text.txt');
    fs.writeFileSync(textPath, tabText, 'utf8');
    await page.screenshot({ path: path.join(screenshotsDir, '02-after-injection.png') });

    const markers = {
      containsLiteralCursorMoves: tabText.includes('[1C'),
      containsBracketedAnsiFlags: /\[\?2026h|\[\?2004h|\[38;5;/.test(tabText),
      spacedClaudeLike: /C\s+l\s+a\s+u\s+d\s+e/i.test(tabText),
      csiFragmentCount: (tabText.match(/\[[0-9;?]+[A-Za-z]/g) || []).length,
      hasClaudeCodeText: /Claude\s*Code/i.test(tabText),
      hasGatewayCompatWarning: /Gateway compatibility warning/i.test(tabText),
      hasProcessExitMarker: tabText.includes('Process exited with code 143') || tabText.includes('[Process exited with code 143]'),
      hasSubmitProbeEcho: tabText.includes(submitProbe),
      hasTerminalSessionOutput: tabText.includes('Welcome to Opus 4.6'),
      hasTerminalSessionInput: tabText.includes('agent-input-marker'),
      hasCommandStillRunningText: tabText.includes('Command still running'),
    };
    report.markers = markers;
    report.textPath = textPath;
    report.tabId = tab.id;
    report.checks.push({ name: 'virtual_tab_captured', passed: true, details: { textPath, tabId: tab.id } });

    if (scenario === 'start-only') {
      if (!markers.hasSubmitProbeEcho) {
        throw new Error('Start-only legacy stream did not echo submitted process input into virtual tab.');
      }
    } else if (scenario === 'terminal-session') {
      if (!markers.hasTerminalSessionOutput) {
        throw new Error('Terminal-session replay did not stream expected output to tab.');
      }
      if (!markers.hasTerminalSessionInput) {
        throw new Error('Terminal-session replay did not render expected input echo to tab.');
      }
      if (markers.hasCommandStillRunningText) {
        throw new Error('Terminal-session replay leaked exec wrapper text into tab.');
      }
      if (!tabText.includes('[Process exited with code 0]')) {
        throw new Error('Terminal-session replay did not mark session exit.');
      }
    } else if (scenario === 'terminal-session-race') {
      if (!markers.hasTerminalSessionOutput) {
        throw new Error('Terminal-session race replay did not stream expected output to tab.');
      }
      if (!markers.hasSubmitProbeEcho) {
        throw new Error('Terminal-session race replay dropped optimistic process input before attach.');
      }
      if (!tabText.includes('[Process exited with code 0]')) {
        throw new Error('Terminal-session race replay did not mark session exit.');
      }
    } else {
      if (markers.containsLiteralCursorMoves || markers.csiFragmentCount > 12) {
        throw new Error('Injected legacy tail still leaked ANSI control fragments into virtual tab text.');
      }
      if (!markers.hasClaudeCodeText || !markers.hasProcessExitMarker) {
        throw new Error('Injected run did not retain readable command context after normalization.');
      }
    }

    report.finishedAt = new Date().toISOString();
    report.passed = true;
    writeJson(path.join(artifactsDir, 'report.json'), report);
    process.stdout.write(`[done] ANSI repro passed. report=${path.join(artifactsDir, 'report.json')}\n`);
  } catch (error) {
    report.finishedAt = new Date().toISOString();
    report.passed = false;
    report.error = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : '',
    };
    writeJson(path.join(artifactsDir, 'report.json'), report);
    process.stderr.write(`[fail] ${report.error.message}\n`);
    process.stderr.write(`[fail] report=${path.join(artifactsDir, 'report.json')}\n`);
    process.exitCode = 1;
  } finally {
    if (app) {
      try {
        await app.close();
      } catch {
        // ignore
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[fatal] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
