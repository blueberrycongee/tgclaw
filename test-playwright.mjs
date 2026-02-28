import { _electron as electron } from 'playwright';
import { setTimeout } from 'timers/promises';

async function main() {
  console.log('Starting tgclaw with Playwright...');

  const app = await electron.launch({
    args: ['.'],
    cwd: '/Users/blueberrycongee/tgclaw',
  });

  const window = await app.firstWindow();
  console.log('Window title:', await window.title());

  // 监听控制台日志
  window.on('console', msg => {
    const text = msg.text();
    if (msg.type() === 'error' || text.includes('error') || text.includes('scope') || text.includes('Gateway')) {
      console.log(`[Console ${msg.type()}]`, text);
    }
  });

  window.on('pageerror', err => {
    console.log('[Page Error]', err.message);
  });

  console.log('Waiting for page to load...');
  await setTimeout(3000);

  // 等待连接
  let status;
  for (let i = 0; i < 15; i++) {
    status = await window.evaluate(() => document.getElementById('gateway-connection-status')?.textContent);
    if (status === 'Connected') break;
    await setTimeout(500);
  }

  if (status !== 'Connected') {
    console.log('❌ Failed to connect');
    await window.screenshot({ path: '/tmp/tgclaw-debug.png', timeout: 5000 }).catch(() => {});
    await app.close();
    process.exit(1);
  }

  console.log('✅ Connected!');
  await setTimeout(1000);

  // 获取发送前聊天区域的内容
  const getMessageContent = async () => {
    return await window.evaluate(() => {
      // 尝试多种选择器获取消息区域
      const selectors = [
        '.messages-container',
        '.chat-messages',
        '#messages',
        '.messages',
        '[class*="message"]'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el.innerText;
      }
      return document.body.innerText;
    });
  };

  const initialContent = await getMessageContent();
  console.log('Initial content length:', initialContent.length);

  // 发送测试消息
  const testMessage = '请回复数字 12345';
  const chatInput = await window.locator('textarea').first();

  if (!await chatInput.isVisible().catch(() => false)) {
    console.log('❌ Chat input not visible');
    await app.close();
    process.exit(1);
  }

  console.log(`\nSending message: "${testMessage}"`);
  await chatInput.fill(testMessage);
  await chatInput.press('Enter');

  // 等待 AI 响应 - 必须看到新内容出现
  console.log('Waiting for AI response (max 120s)...');
  let aiResponded = false;
  let finalContent = '';

  for (let i = 0; i < 240; i++) {  // 最多等 120 秒
    await setTimeout(500);

    // 检查是否有错误
    const gatewayErrors = await window.evaluate(() => {
      const errorEls = document.querySelectorAll('.error, .error-message, [class*="error"]');
      return Array.from(errorEls).map(el => el.textContent).filter(t =>
        t && (t.includes('scope') || t.includes('Gateway') || t.includes('INVALID_REQUEST') || t.includes('Connection error'))
      );
    });

    if (gatewayErrors.length > 0) {
      console.log(`\n❌ Gateway error: ${gatewayErrors[0]}`);
      await window.screenshot({ path: '/tmp/tgclaw-error.png', timeout: 5000 }).catch(() => {});
      await app.close();
      process.exit(1);
    }

    // 获取当前内容
    const currentContent = await getMessageContent();

    // 检查是否有 AI 回复 (包含 12345 的回复)
    if (currentContent.includes('12345') && currentContent.length > initialContent.length + 50) {
      // 确保回复不仅仅是我们发送的消息
      const newContent = currentContent.slice(initialContent.length);
      if (newContent.includes('12345') && newContent.length > 20) {
        aiResponded = true;
        finalContent = currentContent;
        break;
      }
    }

    // 进度指示
    if (i % 10 === 0) {
      process.stdout.write('.');
      // 每5秒截图一次用于调试
      if (i % 20 === 0 && i > 0) {
        await window.screenshot({ path: `/tmp/tgclaw-progress-${i}.png`, timeout: 5000 }).catch(() => {});
      }
    }
  }

  // 最终截图
  await window.screenshot({ path: '/tmp/tgclaw-final-test.png', timeout: 5000 }).catch(() => {});

  if (aiResponded) {
    console.log('\n\n✅ AI responded with content containing "12345"!');
    // 提取新增的内容
    const newContent = finalContent.slice(Math.max(0, finalContent.length - 500));
    console.log('\nLast 500 chars of chat:');
    console.log('---');
    console.log(newContent);
    console.log('---');
    console.log('\nScreenshot saved to /tmp/tgclaw-final-test.png');
    console.log('\n🎉 All tests passed!');
    await app.close();
  } else {
    console.log('\n\n❌ No AI response containing "12345" received within 120 seconds');
    const finalContent = await getMessageContent();
    console.log('\nFinal content (last 500 chars):');
    console.log(finalContent.slice(-500));
    console.log('\nScreenshot saved to /tmp/tgclaw-final-test.png');
    await app.close();
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
