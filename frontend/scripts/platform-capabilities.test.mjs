import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { getPlatformCapabilities } from '../../server/platform.ts';
import { store } from '../src/store.ts';
import { DirectoryBrowser } from '../src/components/DirectoryBrowser.tsx';
import { TaildropMenu } from '../src/components/TaildropMenu.tsx';
import { FilePanel } from '../src/components/FilePanel.tsx';
import { terminalShellOptions } from '../src/terminal.ts';
import { normalizeDirectoryPath, directoryBreadcrumbs } from '../src/directory-path.ts';
import { resolveLocalFileLink } from '../src/file-preview.ts';
globalThis.React = React;
globalThis.window = { location: { hash: "#/" }, innerWidth: 1280 };
const original = store.meta;
const originalPreview = store.filePreview;
try {
  for (const host of ['wsl', 'linux', 'darwin']) {
    const caps = getPlatformCapabilities({ host, local: true, chrome: true, picker: true, powershell: true, powerOff: true, tailscale: true, zip: true });
    store.meta = { capabilities: caps, platform: host, drivers: {} };
    const html = renderToStaticMarkup(React.createElement(DirectoryBrowser, { initialPath: '', allowWindowsPicker: true, onSelect() {}, onClose() {} }));
    assert.equal(html.includes('aria-label="Windows 浏览窗口"'), host === 'wsl');
    assert.equal(html.includes('>Windows</button>'), host === 'wsl');
    assert.equal(html.includes('>WSL</button>'), host === 'wsl');
    assert.equal(html.includes('>主目录</button>'), host !== 'wsl');
    assert.deepEqual(terminalShellOptions(caps.powershell).map(item => item.value), host === 'wsl' ? ['bash', 'powershell'] : ['bash']);
    assert.equal(normalizeDirectoryPath('C:\\Users\\user', caps.windowsPaths), host === 'wsl' ? '/mnt/c/Users/user' : 'C:\\Users\\user');
    assert.equal(directoryBreadcrumbs('/mnt/c/work', caps.windowsPaths)[0].label, host === 'wsl' ? 'C:' : '/');
    assert.equal(resolveLocalFileLink('C:\\Users\\user', '/home/user', caps.windowsPaths), host === 'wsl' ? '/mnt/c/Users/user' : null);
  }
  store.meta = { capabilities: { terminal: true, taildrop: false } };
  const menu = renderToStaticMarkup(React.createElement(TaildropMenu, { enabled: false, folder: true,
    position: { x: 0, y: 0 }, leadingItems: [{ id: 'open', label: '在新标签页内打开', onSelect() {} }], onSend() {}, onClose() {} }));
  assert.ok(menu.includes('在新标签页内打开')); assert.ok(!menu.includes('正在读取 Taildrop'));
  store.filePreview = { target: { path: '/a.txt', root: '/' }, file: { name: 'a.txt', kind: 'text', editable: false, text: 'a' }, draft: 'a', loadId: 1 };
  const panel = renderToStaticMarkup(React.createElement(FilePanel, { onClose() {} }));
  assert.ok(!panel.includes('aria-label="发送到设备"'));
  assert.ok(!panel.includes('aria-label="保存"'));
  const terminal = readFileSync(new URL('../src/components/TerminalPanel.tsx', import.meta.url), 'utf8');
  assert.match(terminal, /terminalShellOptions\(powershell\)/); assert.match(terminal, /options=\{shellOptions\}/);
} finally { store.meta = original; store.filePreview = originalPreview; }
console.log('✅ 三平台目录入口、路径转换、shell选项与禁用发送入口');
