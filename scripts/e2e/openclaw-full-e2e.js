#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright');

const VALID_MODES = new Set(['auto', 'live', 'replay']);

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

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseMode(argv) {
  let rawMode = '';
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--mode') {
      rawMode = String(argv[index + 1] || '').trim();
      break;
    }
    if (token.startsWith('--mode=')) {
      rawMode = token.slice('--mode='.length).trim();
      break;
    }
  }
  if (!rawMode && typeof process.env.TGCLAW_E2E_MODE === 'string') {
    rawMode = process.env.TGCLAW_E2E_MODE.trim();
  }
  const normalized = (rawMode || 'auto').toLowerCase();
  if (!VALID_MODES.has(normalized)) {
    throw new Error(`Invalid mode "${rawMode}". Use one of: auto, live, replay.`);
  }
  return normalized;
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
        const err = new Error(`Command failed (${code}): ${command} ${args.join(' ')}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function waitUntil(predicate, options) {
  const { timeoutMs, intervalMs, label } = options;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function createGatewayConfig(params) {
  const { workspace, gatewayToken, providerAnthropic, defaultModel } = params;
  return {
    gateway: {
      mode: 'local',
      bind: 'loopback',
      auth: {
        mode: 'token',
        token: gatewayToken,
      },
      controlUi: {
        allowedOrigins: ['null', 'file://', 'http://localhost:5173'],
      },
    },
    agents: {
      defaults: {
        workspace,
        maxConcurrent: 1,
        model: defaultModel,
      },
    },
    models: {
      providers: {
        anthropic: providerAnthropic,
      },
    },
  };
}

async function loadHostOpenClawModelConfig() {
  const providerRes = await runCommand('openclaw', ['config', 'get', 'models.providers.anthropic', '--json'], { timeoutMs: 30000 });
  const defaultModelRes = await runCommand('openclaw', ['config', 'get', 'agents.defaults.model', '--json'], { timeoutMs: 30000 });
  const modelStatusRes = await runCommand('openclaw', ['models', 'status', '--json'], { timeoutMs: 30000 });
  const providerAnthropic = safeJsonParse(providerRes.stdout || '{}');
  const defaultModel = safeJsonParse(defaultModelRes.stdout || '"anthropic/claude-opus-4-6"');
  const modelsStatus = safeJsonParse(modelStatusRes.stdout || '{}');
  const authStorePath = typeof modelsStatus?.auth?.storePath === 'string'
    ? modelsStatus.auth.storePath.trim()
    : '';

  if (!providerAnthropic || typeof providerAnthropic !== 'object') {
    throw new Error('Invalid anthropic provider config from openclaw config.');
  }
  if (!Array.isArray(providerAnthropic.models) || providerAnthropic.models.length === 0) {
    throw new Error('openclaw anthropic provider has no models configured.');
  }
  if (typeof providerAnthropic.baseUrl !== 'string' || !providerAnthropic.baseUrl.trim()) {
    throw new Error('openclaw anthropic provider baseUrl is missing.');
  }
  if (typeof defaultModel !== 'string' || !defaultModel.trim()) {
    throw new Error('openclaw default model is missing.');
  }
  if (!authStorePath || !fs.existsSync(authStorePath)) {
    throw new Error('openclaw auth profiles storePath is missing. Run `openclaw models status --json` and configure auth first.');
  }
  return { providerAnthropic, defaultModel, authStorePath };
}

function spawnGateway(params) {
  const { openclawConfigPath, openclawStateDir, gatewayPort, gatewayLogPath } = params;
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: openclawConfigPath,
    OPENCLAW_STATE_DIR: openclawStateDir,
  };
  ensureDir(path.dirname(gatewayLogPath));
  const logStream = fs.createWriteStream(gatewayLogPath, { flags: 'a' });
  const child = spawn('openclaw', ['gateway', 'run', '--port', String(gatewayPort), '--force'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  return { child, logStream };
}

async function waitGatewayHealthy(params) {
  const { openclawConfigPath, openclawStateDir, gatewayUrl, gatewayToken } = params;
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: openclawConfigPath,
    OPENCLAW_STATE_DIR: openclawStateDir,
  };
  await waitUntil(async () => {
    try {
      await runCommand(
        'openclaw',
        ['gateway', 'health', '--url', gatewayUrl, '--token', gatewayToken, '--json'],
        { timeoutMs: 15000, env },
      );
      return true;
    } catch {
      return false;
    }
  }, {
    timeoutMs: 60000,
    intervalMs: 1000,
    label: `gateway health at ${gatewayUrl}`,
  });
}

async function ensureConnected(page, gatewayUrl, gatewayToken) {
  await page.waitForSelector('#chat-status-text', { timeout: 30000 });
  const isOnline = async () => {
    const text = await page.locator('#chat-status-text').innerText();
    return text.trim() === 'Online';
  };
  if (await isOnline()) return;

  await page.click('#gateway-settings-btn');
  await page.fill('#gateway-url', gatewayUrl);
  await page.fill('#gateway-token', gatewayToken);
  await page.click('#gateway-connect');
  await waitUntil(async () => await isOnline(), {
    timeoutMs: 45000,
    intervalMs: 1000,
    label: 'TGClaw gateway online status',
  });
}

async function selectProject(page, projectId) {
  await page.click(`[data-project-id="${projectId}"]`);
  await page.waitForSelector(`#project-list [data-project-id="${projectId}"].active`, { timeout: 15000 });
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

async function emitGatewayEvent(page, frame) {
  return await page.evaluate(
    (payload) => window.__TGCLAW_E2E__?.emitGatewayEvent?.(payload) === true,
    frame,
  );
}

async function runAgentExecCall(params) {
  const {
    openclawConfigPath,
    openclawStateDir,
    gatewayUrl,
    gatewayToken,
    projectPath,
    outputPathBase,
  } = params;
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: openclawConfigPath,
    OPENCLAW_STATE_DIR: openclawStateDir,
  };
  const requestId = `tgclaw-e2e-${Date.now()}`;
  const rpcParams = JSON.stringify({
    agentId: 'main',
    sessionKey: 'agent:main:main',
    idempotencyKey: requestId,
    message: `You must call the exec tool exactly once. Run command pwd in workdir ${projectPath}. Then answer with the command output only.`,
  });

  return await runCommand(
    'openclaw',
    [
      'gateway',
      'call',
      'agent',
      '--url',
      gatewayUrl,
      '--token',
      gatewayToken,
      '--expect-final',
      '--timeout',
      '240000',
      '--params',
      rpcParams,
      '--json',
    ],
    {
      timeoutMs: 260000,
      env,
      stdoutFile: `${outputPathBase}.out.log`,
      stderrFile: `${outputPathBase}.err.log`,
    },
  );
}

function detectLiveAuthBlock(stdoutText) {
  const parsed = safeJsonParse(stdoutText || '');
  const texts = [];
  if (parsed && typeof parsed === 'object') {
    const payloads = Array.isArray(parsed?.result?.payloads) ? parsed.result.payloads : [];
    payloads.forEach((payload) => {
      if (payload && typeof payload.text === 'string') texts.push(payload.text);
    });
  }
  const haystack = `${stdoutText || ''}\n${texts.join('\n')}`.toLowerCase();
  const patterns = [
    /api key has expired/i,
    /invalid api key/i,
    /authentication/i,
    /unauthorized/i,
    /forbidden/i,
    /status\s*403/i,
    /potluck_error/i,
  ];
  const blocked = patterns.some((pattern) => pattern.test(haystack));
  if (!blocked) return { blocked: false, reason: '' };
  const firstLine = texts.find((line) => typeof line === 'string' && line.trim()) || '';
  return {
    blocked: true,
    reason: firstLine.trim() || 'Live model auth/provider is unavailable.',
  };
}

async function replayOpenclawExecEvents(params) {
  const { page, projectPath } = params;
  const stamp = Date.now();
  const toolCallId = `replay-tool-${stamp}`;
  const sessionId = `replay-session-${stamp}`;

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
            command: 'pwd',
            workdir: projectPath,
            pty: true,
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
            sessionId,
            action: 'write',
            data: 'pwd\n',
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
              tail: `${projectPath}\n`,
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
              status: 'completed',
              exitCode: 0,
            },
            content: [
              {
                type: 'text',
                text: projectPath,
              },
            ],
          },
        },
      },
    },
  ];

  for (const frame of frames) {
    const ok = await emitGatewayEvent(page, frame);
    if (!ok) {
      throw new Error('Failed to inject replay gateway frame into TGClaw renderer.');
    }
    await sleep(80);
  }

  return { toolCallId, sessionId };
}

function buildTgclawConfig(params) {
  const {
    projectAPath,
    projectBPath,
    mode,
    gatewayUrl,
    gatewayToken,
  } = params;

  if (mode === 'live') {
    return {
      projects: [
        { id: 'proj-a', name: 'E2E Project A', cwd: projectAPath },
        { id: 'proj-b', name: 'E2E Project B', cwd: projectBPath },
      ],
      gatewayConfig: {
        url: gatewayUrl,
        token: gatewayToken,
        configured: true,
      },
      gateway: {
        url: gatewayUrl,
        token: gatewayToken,
      },
    };
  }

  return {
    projects: [
      { id: 'proj-a', name: 'E2E Project A', cwd: projectAPath },
      { id: 'proj-b', name: 'E2E Project B', cwd: projectBPath },
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

async function closeProcess(child, name) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  const done = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!done) {
    child.kill('SIGKILL');
  }
  await sleep(100);
  if (name) process.stdout.write(`[cleanup] stopped ${name}\n`);
}

async function main() {
  const requestedMode = parseMode(process.argv.slice(2));
  let effectiveMode = requestedMode === 'auto' ? 'live' : requestedMode;

  const repoRoot = process.cwd();
  const stamp = nowStamp();
  const artifactsDir = path.join(repoRoot, 'output', 'e2e', `openclaw-full-${stamp}`);
  const openclawDir = path.join(artifactsDir, 'openclaw');
  const tgclawDir = path.join(artifactsDir, 'tgclaw');
  const screenshotsDir = path.join(artifactsDir, 'screenshots');
  const logsDir = path.join(artifactsDir, 'logs');
  ensureDir(openclawDir);
  ensureDir(tgclawDir);
  ensureDir(screenshotsDir);
  ensureDir(logsDir);

  const projectAPath = repoRoot;
  let projectBPath = path.join(repoRoot, 'thirdparty', 'openclaw');
  if (!fs.existsSync(projectBPath)) {
    projectBPath = path.join(artifactsDir, 'project-b');
    ensureDir(projectBPath);
  }

  const gatewayPort = 18999;
  const gatewayToken = `tgclaw-e2e-${Date.now()}`;
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}`;
  const openclawStateDir = path.join(openclawDir, 'state');
  const openclawConfigPath = path.join(openclawDir, 'openclaw.json');
  const gatewayLogPath = path.join(logsDir, 'gateway.log');
  const tgclawUserDataDir = path.join(tgclawDir, 'user-data');

  let gatewayChild = null;
  let gatewayLogStream = null;
  let electronApp = null;
  const report = {
    startedAt: new Date().toISOString(),
    artifactsDir,
    requestedMode,
    effectiveMode,
    gateway: {
      url: gatewayUrl,
      port: gatewayPort,
      logPath: gatewayLogPath,
    },
    checks: [],
  };

  try {
    if (effectiveMode === 'live') {
      process.stdout.write('[step] loading host OpenClaw model config\n');
      try {
        const { providerAnthropic, defaultModel, authStorePath } = await loadHostOpenClawModelConfig();
        const gatewayConfig = createGatewayConfig({
          workspace: projectAPath,
          gatewayToken,
          providerAnthropic,
          defaultModel,
        });
        ensureDir(openclawStateDir);
        writeJson(openclawConfigPath, gatewayConfig);
        const isolatedAuthPath = path.join(openclawStateDir, 'agents', 'main', 'agent', 'auth-profiles.json');
        ensureDir(path.dirname(isolatedAuthPath));
        fs.copyFileSync(authStorePath, isolatedAuthPath);

        process.stdout.write('[step] starting isolated OpenClaw gateway\n');
        const gatewaySpawn = spawnGateway({
          openclawConfigPath,
          openclawStateDir,
          gatewayPort,
          gatewayLogPath,
        });
        gatewayChild = gatewaySpawn.child;
        gatewayLogStream = gatewaySpawn.logStream;
        await waitGatewayHealthy({
          openclawConfigPath,
          openclawStateDir,
          gatewayUrl,
          gatewayToken,
        });
        report.checks.push({ name: 'gateway_healthy', passed: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (requestedMode === 'live') {
          throw new Error(`Live mode setup failed: ${message}`);
        }
        effectiveMode = 'replay';
        report.effectiveMode = effectiveMode;
        report.checks.push({
          name: 'live_setup_available',
          passed: false,
          details: { message },
        });
        process.stdout.write(`[info] live setup unavailable, fallback to replay: ${message}\n`);
      }
    }

    process.stdout.write('[step] preparing TGClaw isolated user data\n');
    ensureDir(tgclawUserDataDir);
    writeJson(
      path.join(tgclawUserDataDir, 'config.json'),
      buildTgclawConfig({
        projectAPath,
        projectBPath,
        mode: effectiveMode,
        gatewayUrl,
        gatewayToken,
      }),
    );

    process.stdout.write('[step] building renderer\n');
    await runCommand('npm', ['run', 'build:renderer'], {
      cwd: repoRoot,
      timeoutMs: 180000,
      stdoutFile: path.join(logsDir, 'build-renderer.out.log'),
      stderrFile: path.join(logsDir, 'build-renderer.err.log'),
    });

    process.stdout.write('[step] launching TGClaw in Electron\n');
    const electronBinary = require('electron');
    electronApp = await electron.launch({
      executablePath: electronBinary,
      args: [repoRoot],
      env: {
        ...process.env,
        TGCLAW_USER_DATA_DIR: tgclawUserDataDir,
        TGCLAW_E2E: '1',
      },
    });
    const page = await electronApp.firstWindow();
    await page.waitForSelector('#chat-input', { timeout: 30000 });
    await page.screenshot({ path: path.join(screenshotsDir, '01-chat-initial.png') });

    if (effectiveMode === 'live') {
      process.stdout.write('[step] ensuring TGClaw connected to gateway\n');
      await ensureConnected(page, gatewayUrl, gatewayToken);
      report.checks.push({ name: 'tgclaw_gateway_connected', passed: true });
    } else {
      report.checks.push({ name: 'tgclaw_started_replay_mode', passed: true });
    }

    process.stdout.write('[step] creating manual tab in project A\n');
    await selectProject(page, 'proj-a');
    await page.click('#add-tab');
    const afterManual = await waitUntil(async () => {
      const snap = await getSnapshot(page);
      const tabs = snap?.tabsByProject?.['proj-a'] || [];
      if (tabs.length >= 1) return snap;
      return null;
    }, {
      timeoutMs: 30000,
      intervalMs: 500,
      label: 'manual tab creation in project A',
    });
    const manualTabs = afterManual.tabsByProject['proj-a'];
    const manualTabId = manualTabs[manualTabs.length - 1].id;
    report.checks.push({ name: 'manual_tab_created', passed: true, details: { manualTabId } });
    await page.screenshot({ path: path.join(screenshotsDir, '02-manual-tab-created.png') });

    let runtimeMode = effectiveMode;
    if (runtimeMode === 'live') {
      process.stdout.write('[step] triggering real OpenClaw agent run (exec tool expected)\n');
      await page.click('.sidebar-item.pinned[data-id="openclaw"]');
      const callResult = await runAgentExecCall({
        openclawConfigPath,
        openclawStateDir,
        gatewayUrl,
        gatewayToken,
        projectPath: projectAPath,
        outputPathBase: path.join(logsDir, 'agent-call'),
      });

      const authCheck = detectLiveAuthBlock(callResult.stdout);
      if (authCheck.blocked) {
        report.checks.push({
          name: 'live_agent_auth_available',
          passed: false,
          details: { reason: authCheck.reason },
        });

        if (requestedMode === 'live') {
          throw new Error(`Live agent call blocked by auth/provider: ${authCheck.reason}`);
        }

        runtimeMode = 'replay';
        report.effectiveMode = runtimeMode;
        process.stdout.write(`[info] live agent auth blocked, fallback to replay: ${authCheck.reason}\n`);
      } else {
        report.checks.push({ name: 'live_agent_call_completed', passed: true });
      }
    }

    if (runtimeMode === 'replay') {
      process.stdout.write('[step] replaying tool-event stream (deterministic fallback)\n');
      await page.click('.sidebar-item.pinned[data-id="openclaw"]');
      const replayMeta = await replayOpenclawExecEvents({
        page,
        projectPath: projectAPath,
      });
      report.checks.push({ name: 'replay_tool_events_injected', passed: true, details: replayMeta });
    }

    const afterAgent = await waitUntil(async () => {
      const snap = await getSnapshot(page);
      const tabs = snap?.tabsByProject?.['proj-a'] || [];
      if (tabs.length >= 2) return snap;
      return null;
    }, {
      timeoutMs: 120000,
      intervalMs: 1000,
      label: 'OpenClaw-created tab in project A',
    });
    const tabsAfterAgent = afterAgent.tabsByProject['proj-a'];
    const openclawTab = tabsAfterAgent.find((tab) => tab.id !== manualTabId) || tabsAfterAgent[tabsAfterAgent.length - 1];
    const openclawTabId = openclawTab.id;
    report.checks.push({ name: 'openclaw_tab_created', passed: true, details: { openclawTabId, mode: runtimeMode } });

    await selectProject(page, 'proj-a');
    const openclawText = await getTabText(page, 'proj-a', openclawTabId);
    const textPath = path.join(logsDir, 'openclaw-tab-text.txt');
    fs.writeFileSync(textPath, openclawText, 'utf8');
    const hasPwdEvidence = /\bpwd\b/i.test(openclawText) || openclawText.includes(projectAPath);
    if (!hasPwdEvidence) {
      throw new Error(`OpenClaw tab text missing expected command/output evidence. See ${textPath}`);
    }
    report.checks.push({ name: 'openclaw_tab_has_command_history', passed: true, details: { textPath } });

    process.stdout.write('[step] verifying project switch persistence\n');
    await selectProject(page, 'proj-b');
    await selectProject(page, 'proj-a');
    const afterSwitch = await getSnapshot(page);
    const switchedTabs = afterSwitch?.tabsByProject?.['proj-a'] || [];
    const stillExists = switchedTabs.some((tab) => tab.id === openclawTabId);
    if (!stillExists) {
      throw new Error('OpenClaw-created tab disappeared after project switch.');
    }
    report.checks.push({ name: 'tab_persists_after_project_switch', passed: true });
    await page.screenshot({ path: path.join(screenshotsDir, '03-after-switch-back.png') });

    report.finishedAt = new Date().toISOString();
    report.passed = true;
    writeJson(path.join(artifactsDir, 'report.json'), report);
    process.stdout.write(`[done] E2E passed. mode=${report.effectiveMode} report=${path.join(artifactsDir, 'report.json')}\n`);
  } catch (error) {
    report.finishedAt = new Date().toISOString();
    report.passed = false;
    report.error = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : '',
    };
    writeJson(path.join(artifactsDir, 'report.json'), report);
    process.stderr.write(`[fail] ${report.error.message}\n`);
    process.stderr.write(`[fail] report: ${path.join(artifactsDir, 'report.json')}\n`);
    process.exitCode = 1;
  } finally {
    if (electronApp) {
      try {
        await electronApp.close();
      } catch {
        // ignore close failures
      }
    }
    if (gatewayChild) {
      await closeProcess(gatewayChild, 'openclaw gateway');
    }
    if (gatewayLogStream) gatewayLogStream.end();
  }
}

main().catch((error) => {
  process.stderr.write(`[fatal] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
