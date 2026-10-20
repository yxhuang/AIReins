"use strict";

(() => {
  const messages = {
    en: {
      skip: "Skip to content",
      navigation: "Main navigation",
      language: "Language",
      navFeatures: "Features",
      navHow: "How it works",
      navSecurity: "Security",
      heroLine1: "Let the agents run.",
      heroLine2: "Keep the reins.",
      heroDescription: "Your AI workbench, on your own computer. Use Claude Code, Codex and Kimi Code from a browser on your desktop or phone.",
      github: "View on GitHub",
      getStarted: "Get started",
      officialClis: "Official CLIs",
      featuresTitle: "One workbench for all three.",
      featuresIntro: "Keep the tools you already use. Bring the work into one place.",
      harnessTitle: "Your setup comes with you.",
      harnessText: "Official CLIs, existing logins. Your instructions, skills, hooks, MCP servers and plugins load as usual. Nothing to migrate.",
      controlTitle: "The next move is yours.",
      controlText: "Approve or deny tool calls, answer questions and interrupt a run. Everything waiting on you, across all sessions, is collected in one place.",
      historyTitle: "Pick up where you left off.",
      historyText: "Search, filter by folder and resume the native history of all three CLIs. Sessions stay in each CLI’s own history.",
      desktopTitle: "See the work as it happens.",
      desktopText: "Sessions together, approvals in view, sub-agents in a tree. Files and a multi-tab terminal are right at hand.",
      dispatchNote: "The dispatch chart also shows runs from an external delegation tool when connected. Without one, it shows native sub-agents.",
      phoneTitle: "Step away. Stay in control.",
      phoneText: "Connect back over Tailscale. Approve a tool call, answer a question or browse your files, all from your phone.",
      terminalNote: "Add it to your home screen to open it like an app. The remote terminal is off by default; enable it when you need it.",
      demoNote: "Screenshots from a local instance running on demo data; the sessions and paths are made up.",
      howTitle: "Your browser. Your computer.",
      howIntro: "One Node process. The official CLIs. Your existing logins.",
      howText: "On the same computer, your browser connects directly to loopback. From another device, join your tailnet: Tailscale Serve forwards to AIReins’ remote entry, which checks Host/Origin and allows only the Tailscale logins you approve. The local Node process drives the official CLIs and writes sessions to their own history.",
      securityTitle: "Read Security first.",
      securityStatement: "This is access to your whole computer.",
      securityText: "Anyone who can reach AIReins has the power of your user account on that machine.",
      readSecurity: "Read Security in the README",
      loopbackTitle: "Loopback only",
      loopbackText: "AIReins listens on the local loopback address.",
      tailnetTitle: "Your tailnet, your allowlist",
      tailnetText: "Remote access goes only through Tailscale, for logins you explicitly allow.",
      exposureTitle: "Keep it off the public internet",
      exposureText: "Never expose AIReins with Funnel or port forwarding.",
      startTitle: "Keep the reins in your hand.",
      startText: "Installation, prerequisites and remote setup are in the README.",
      platforms: "Windows + WSL2 and native Linux supported. macOS is experimental, with CI coverage only.",
      startButton: "Get started in the README",
      license: "Code: MIT License",
      notice: "Name & marks: NOTICE",
      description: "Let the agents run. Keep the reins. A local workbench for Claude Code, Codex and Kimi Code, from your desktop or phone.",
      bannerAlt: "Claude Code, Codex and Kimi Code converge through AR on an Approve button on your phone",
      desktopAlt: "Desktop: sessions from three agents on the left, a Claude session with a pending approval in the middle, and the dispatch flow chart on the right showing Codex and Kimi runs live",
      mobileAlt: "Three phone screens: the session list, a session with an approval card, and the terminal",
      howAlt: "Six steps: open, your tailnet, one process, official CLIs, whole computer, your call"
    },
    zh: {
      skip: "跳到正文",
      navigation: "主导航",
      language: "语言",
      navFeatures: "亮点",
      navHow: "工作原理",
      navSecurity: "安全",
      heroLine1: "AI 尽管往前跑，",
      heroLine2: "缰绳始终在你手里。",
      heroDescription: "跑在你自己电脑上的 AI 工作台。在电脑或手机的浏览器里，用 Claude Code、Codex 和 Kimi Code 做事。",
      github: "在 GitHub 查看",
      getStarted: "开始使用",
      officialClis: "官方 CLI",
      featuresTitle: "一个工作台，三家 AI。",
      featuresIntro: "沿用熟悉的工具，把手头的工作放在同一处。",
      harnessTitle: "你的配置，照常加载。",
      harnessText: "官方 CLI，已有的登录。指令文件、skills、hooks、MCP 和插件照常加载，不用迁移。",
      controlTitle: "下一步，由你拍板。",
      controlText: "批准或拒绝工具调用、回答提问，也能中途打断。所有会话里待你处理的事，集中在一处。",
      historyTitle: "原生历史，随时续接。",
      historyText: "在一处搜索三家 CLI 的原生历史，按目录筛选、续接会话。会话仍写在各家 CLI 自己的历史里。",
      desktopTitle: "看得见每一步。",
      desktopText: "会话集中呈现，审批就在眼前，子代理按父子树展开。文件和多标签终端也在手边。",
      dispatchNote: "接入外部委派工具后，派单图也会显示委派任务；没有接入时，显示各家原生子代理。",
      phoneTitle: "离开电脑，也能把住方向。",
      phoneText: "经 Tailscale 连回电脑。在手机上批准工具调用、回答 AI 的提问，或浏览文件。",
      terminalNote: "添加到主屏幕，就能像 App 一样打开。远程终端默认关闭，需要时再显式开启。",
      demoNote: "截图来自使用演示数据的本地实例，其中的会话和路径均为虚构。",
      howTitle: "你的浏览器，连回你的电脑。",
      howIntro: "一个 Node 进程，官方 CLI，沿用已有的登录。",
      howText: "本机浏览器直连回环地址。其他设备先加入你的 tailnet，再由 Tailscale Serve 转发到 AIReins 的远程入口；入口检查 Host/Origin，只放行白名单中的 Tailscale 登录。本机 Node 进程驱动官方 CLI，会话写入各家自己的原生历史。",
      securityTitle: "使用之前，先读安全说明。",
      securityStatement: "它给的是整台电脑的权限。",
      securityText: "能连上 AIReins 的人，就有你这个用户账户在这台电脑上的全部能力。",
      readSecurity: "阅读 README 中的安全说明",
      loopbackTitle: "只监听本机回环地址",
      loopbackText: "AIReins 只在 loopback 上监听。",
      tailnetTitle: "远程只走 Tailscale，并检查白名单",
      tailnetText: "只放行你明确允许的 Tailscale 登录。",
      exposureTitle: "不要暴露到公网",
      exposureText: "绝不要使用 Funnel 或端口转发对外暴露 AIReins。",
      startTitle: "把缰绳握在自己手里。",
      startText: "安装步骤、前置条件和远程配置，都在 README 里。",
      platforms: "支持 Windows + WSL2、原生 Linux。macOS 为实验性支持，仅有 CI 覆盖。",
      startButton: "前往 README，开始使用",
      license: "代码：MIT 许可证",
      notice: "名称与标志：见 NOTICE",
      description: "AI 尽管往前跑，缰绳始终在你手里。跑在自己电脑上的 Claude Code、Codex、Kimi Code 工作台，电脑和手机都能用。",
      bannerAlt: "Claude Code、Codex 和 Kimi Code 经 AR 汇聚到手机上的批准按钮",
      desktopAlt: "桌面：左侧三家会话，中间 Claude 会话与待审批卡片，右侧派单流程图实时显示 Codex 与 Kimi 的执行状态",
      mobileAlt: "手机三页：会话列表首页、带审批卡片的会话、终端",
      howAlt: "六步：打开、私网、本机、官方 CLI、整台电脑、你来拍板"
    }
  };

  const docs = {
    en: {
      start: "https://github.com/yxhuang/AIReins#get-started",
      security: "https://github.com/yxhuang/AIReins#security"
    },
    zh: {
      start: "https://github.com/yxhuang/AIReins/blob/main/README.zh-CN.md#跑起来",
      security: "https://github.com/yxhuang/AIReins/blob/main/README.zh-CN.md#安全"
    }
  };
  const storageKey = "aireins-site-language";

  function initialLanguage() {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === "en" || saved === "zh") return saved;
    } catch { /* Browser storage may be disabled. */ }
    return (navigator.language || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
  }

  function setLanguage(language) {
    const copy = messages[language];
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    document.querySelectorAll("[data-i18n]").forEach(element => {
      element.textContent = copy[element.dataset.i18n];
    });
    document.querySelectorAll("[data-i18n-aria]").forEach(element => {
      element.setAttribute("aria-label", copy[element.dataset.i18nAria]);
    });
    document.querySelectorAll("[data-language]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.language === language));
    });
    document.querySelectorAll("[data-doc]").forEach(link => {
      link.href = docs[language][link.dataset.doc];
    });
    document.querySelectorAll("picture[data-image]").forEach(picture => {
      const name = picture.dataset.image;
      picture.querySelector("source").srcset = `./assets/${name}-${language}-dark.png`;
      const image = picture.querySelector("img");
      image.src = `./assets/${name}-${language}-light.png`;
      image.alt = copy[`${name}Alt`];
    });
    document.querySelector('meta[name="description"]').content = copy.description;
    document.querySelector('meta[property="og:description"]').content = copy.description;
  }

  document.querySelectorAll("[data-language]").forEach(button => {
    button.addEventListener("click", () => {
      const language = button.dataset.language;
      setLanguage(language);
      try { localStorage.setItem(storageKey, language); } catch { /* Switching still works without storage. */ }
    });
  });
  setLanguage(initialLanguage());
})();
