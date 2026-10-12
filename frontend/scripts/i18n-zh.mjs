// Existing wording assertions explicitly select Chinese before module-level labels initialize.
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'zh-CN' } });
