import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  manifest: {
    name: 'BookMind Next · 收藏复盘',
    description: '沿用原生收藏，记录链接与必要预览并提醒回看，数据保存在本机。',
    minimum_chrome_version: '120',
    permissions: ['bookmarks', 'storage', 'alarms', 'notifications', 'scripting', 'activeTab'],
    host_permissions: ['https://www.bilibili.com/*'],
    optional_host_permissions: ['https://www.zhihu.com/*', 'https://zhuanlan.zhihu.com/*', 'https://x.com/*'],
    icons: { 16: 'icon/16.png', 48: 'icon/48.png', 128: 'icon/128.png' },
  },
  vite: () => ({ plugins: [tailwindcss()] }),
});
