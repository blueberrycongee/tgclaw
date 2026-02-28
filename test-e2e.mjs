#!/usr/bin/env node
import { _electron as electron } from 'playwright';
import { spawn } from 'child_process';
import { setTimeout as delay } from 'timers/promises';

const TGCLAW_PATH = process.cwd();
const OPENCLAW_LOG = '/tmp/openclaw/openclaw-2026-03-01.log';
const TEST_TIMEOUT_MS = 120_000;

function log(level, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}]`, ...args);
}

function logInfo(...args) { log('INFO', ...args); }
function logWarn(...args) { log('WARN', ...args); }
function logError(...args) { log('ERROR', ...args); }

async function tailOpenclaw(callback) {
  const tail = spawn('tail', ['-f', OPENCLAW_LOG], { stdio: ['ignore', 'pipe', 'ignore'] });
  tail.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        callback(parsed);
      } catch {
        // ignore
      }
    }
  });
  return tail;
}

async function runE2ETest() {
  logInfo('=== TGClaw E2E Test Start ===');

  // Start tailing openclaw logs
  let runCompleted = false;
  let runError = null;
  let toolCalls = [];

  const logTail = await tailOpenclaw((entry) => {
    const msg = entry['1'] || '';

    // Track agent run events
    if (typeof msg === 'string') {
      if (msg.includes('embedded run start')) {
        logInfo('[openclaw] Agent run started');
      }
      if (msg.includes('embedded run tool start')) {
        const match = msg.match(/tool=(\w+)/);
        if (match) {
          logInfo(`[openclaw] Tool call started: ${match[1]}`);
          toolCalls.push({ tool: match[1], status: 'started' });
        }
      }
      if (msg.includes('embedded run tool end')) {
        const match = msg.match(/tool=(\w+)/);
        if (match) {
          logInfo(`[openclaw] Tool call ended: ${match[1]}`);
        }
      }
      if (msg.includes('embedded run done') || msg.includes('embedded run prompt end')) {
        logInfo('[openclaw] Agent run completed');
        runCompleted = true;
      }
      if (msg.includes('isError=true')) {
        logError('[openclaw] Agent run error detected');
        runError = msg;
      }
    }

    // Track node.invoke events
    if (typeof msg === 'string' && (msg.includes('node.invoke') || msg.includes('system.run'))) {
      logInfo(`[openclaw] ${msg}`);
    }
  });

  // Launch Electron app
  logInfo('Launching TGClaw with Playwright...');
  const electronApp = await electron.launch({
    args: [TGCLAW_PATH],
    timeout: 30000,
  });

  // Wait for first window
  const page = await electronApp.firstWindow();
  logInfo('TGClaw window opened');

  // Wait for app to fully load
  await delay(5000);

  try {
    // Find the chat input and send a message
    logInfo('Looking for chat input...');
    const chatInput = await page.locator('#chat-input, textarea[placeholder*="message"], .chat-input').first();
    await chatInput.waitFor({ state: 'visible', timeout: 15000 });
    logInfo('Chat input found');

    // Type a test message
    const testMessage = '你好，请执行 echo "Hello from TGClaw E2E Test"';
    logInfo(`Sending test message: ${testMessage}`);
    await chatInput.fill(testMessage);

    // Send the message (Enter or click send button)
    const sendButton = await page.locator('#send-btn, button[type="submit"], .send-button').first();
    if (await sendButton.isVisible()) {
      logInfo('Clicking send button...');
      await sendButton.click();
    } else {
      logInfo('Pressing Enter to send...');
      await chatInput.press('Enter');
    }

    logInfo('Message sent, waiting for AI response...');

    // Wait for response with timeout
    const startTime = Date.now();
    while (!runCompleted && (Date.now() - startTime) < TEST_TIMEOUT_MS) {
      await delay(1000);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (elapsed % 10 === 0) {
        logInfo(`Waiting for response... (${elapsed}s elapsed)`);
      }
    }

    if (runCompleted) {
      logInfo('✅ AI response completed successfully!');
      logInfo(`Tool calls made: ${toolCalls.length}`);
      toolCalls.forEach((tc, i) => logInfo(`  ${i + 1}. ${tc.tool}`));
    } else {
      logWarn('⚠️ Timeout waiting for AI response');
    }

    if (runError) {
      logError('❌ AI run encountered an error:', runError);
    }

    // Take a screenshot
    const screenshotPath = `${TGCLAW_PATH}/e2e-test-result.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    logInfo(`Screenshot saved: ${screenshotPath}`);

  } catch (err) {
    logError('Test error:', err.message);
  } finally {
    logInfo('Cleaning up...');
    logTail.kill();
    await electronApp.close();
  }

  logInfo('=== TGClaw E2E Test End ===');
  process.exit(runCompleted && !runError ? 0 : 1);
}

runE2ETest().catch((err) => {
  logError('Fatal error:', err);
  process.exit(1);
});
