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
      releaseBanner: "Google Antigravity · Built-in 4-provider usage panel",
      heroLine1: "Let the agents run.",
      heroLine2: "Keep the reins.",
      heroDescription: "Your AI workbench, on your own computer. Use Claude Code, Antigravity, Codex and Kimi Code from a browser on your desktop or phone.",
      github: "View on GitHub",
      getStarted: "Get started",
      officialClis: "Official CLIs",
      featuresTitle: "One workbench for all four.",
      featuresIntro: "Keep the official CLIs you already use. Bring sessions, files, quotas and approvals into one place.",
      harnessTitle: "Your setup comes with you.",
      harnessText: "Official CLIs (claude, agy, codex, kimi), existing logins. Your CLAUDE.md, AGENTS.md, GEMINI.md, skills, hooks, MCP servers and plugins load as usual, with per-session model and effort pickers.",
      controlTitle: "The next move is yours.",
      controlText: "Approve or deny tool calls, answer questions, interrupt or steer mid-run, and see per-turn durations live. Click the context ring for native compaction and recall submitted prompts with ↑ / ↓.",
      usageTitle: "Quotas and reset notices built in.",
      usageText: "Track Claude, Antigravity, Codex and Kimi subscription quotas in one native panel with elapsed-window pace marks, per-provider refresh and opt-in four-provider reset announcements — no extra service needed.",
      wholeTitle: "The whole computer, not one session.",
      wholeText: "Browse any folder, including Windows drives under WSL. Preview and edit files, flip through folder images, open Office files locally, and use a multi-tab terminal (remote access toggled right in Settings).",
      leadTitle: "One leads, the others follow.",
      leadText: "Follow external delegate runs, native sub-agents, and Antigravity Orchestrator phases and Swarm workers live in one parent/child dispatch tree, on desktop or phone.",
      privateTitle: "No vendor relay. Native history stays yours.",
      privateText: "Traffic stays on your tailnet with zero telemetry. Search and resume native Claude, Codex and Kimi history, resume AIReins Antigravity sessions via ACP, and reorder or drag conversations across folders.",
      desktopTitle: "See the work as it happens.",
      desktopText: "Sessions together, approvals in view, live turn durations, and Antigravity Orchestrator/Swarm nodes alongside sub-agents. Reorder file and terminal tabs and move them between the main and side panes.",
      dispatchNote: "The dispatch chart also shows runs from an external delegation tool when connected. Without one, it shows native sub-agents and Antigravity Orchestrator/Swarm activity.",
      phoneTitle: "Step away. Stay in control.",
      phoneText: "Connect back over Tailscale. Approve tools, answer questions, check four-provider quotas and browse files. Recover unconfirmed inputs, retry failed views and read wrapping tables.",
      terminalNote: "Add it to your home screen to open it like an app. The remote terminal is off by default; toggle it anytime in Settings → Host.",
      demoNote: "Screenshots from a local instance running on demo data; the sessions and paths are made up.",
      howTitle: "Your browser. Your computer.",
      howIntro: "One Node process. The official CLIs. Your existing logins.",
      howText: "On the same computer, your browser connects directly to loopback. From another device, join your tailnet: Tailscale Serve forwards to AIReins’ remote entry, which checks Host/Origin and allows only the Tailscale logins you approve. The local Node process drives the four official CLIs over stream-json, ACP and codex app-server.",
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
      startText: "One command installs and builds it; prerequisites and remote setup are in the README.",
      copy: "Copy",
      copied: "Copied",
      copyFailed: "Copy failed",
      platforms: "Windows + WSL2 and native Linux supported. macOS is experimental, with CI coverage only.",
      startButton: "Get started in the README",
      release: "v0.6.0 · Release notes",
      license: "Code: MIT License",
      notice: "Name & marks: NOTICE",
      description: "Let the agents run. Keep the reins. A local workbench for Claude Code, Antigravity, Codex and Kimi Code, from your desktop or phone.",
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
      releaseBanner: "接入 Google Antigravity · 内置四家 AI 用量面板",
      heroLine1: "AI 尽管往前跑，",
      heroLine2: "缰绳始终在你手里。",
      heroDescription: "跑在你自己电脑上的 AI 工作台。在电脑或手机的浏览器里，用 Claude Code、Antigravity、Codex 和 Kimi Code 做事。",
      github: "在 GitHub 查看",
      getStarted: "开始使用",
      officialClis: "官方 CLI",
      featuresTitle: "一个工作台，四家 AI。",
      featuresIntro: "沿用熟悉的官方 CLI，把会话、文件、额度与审批收拢到同一处。",
      harnessTitle: "你的配置，照常加载。",
      harnessText: "官方 CLI（claude、agy、codex、kimi），已有的登录。CLAUDE.md、AGENTS.md、GEMINI.md、skills、hooks、MCP 和插件照常加载，每个会话都能独立选模型和推理档位。",
      controlTitle: "下一步，由你拍板。",
      controlText: "批准或拒绝工具调用、回答提问、中途打断或插话，并实时看到每回合耗时。点击上下文圆环请求原生压缩，按 ↑ / ↓ 调出已发送的历史输入。",
      usageTitle: "额度与重置公告内置直达。",
      usageText: "在一个原生面板里追踪 Claude、Antigravity、Codex 和 Kimi 订阅额度，带时间进度刻度、单家或并行刷新，以及可选的四家重置公告折叠条，无需另装 Python 服务。",
      wholeTitle: "整台电脑，而不只是一个会话。",
      wholeText: "浏览任意文件夹，WSL 下也包括 Windows 盘符。预览和编辑文件，逐张翻看目录图片，在本机把 Office 文件交给系统程序打开，还有多标签终端（远程开关就在设置里）。",
      leadTitle: "一家主导，其余协作。",
      leadText: "接入委派工具后，在电脑或手机上实时跟踪派单树；各家原生子代理、Antigravity Orchestrator 阶段与 Swarm 子代理也同树展开。",
      privateTitle: "无厂商中转，原生历史留在你手里。",
      privateText: "流量只在你的 tailnet 内，无账号、无遥测。可搜索并续接 Claude、Codex、Kimi 原生历史，通过 ACP 续接工作台 Antigravity 会话，也支持目录内排序和跨目录拖拽。",
      desktopTitle: "看得见每一步。",
      desktopText: "会话集中呈现，审批与回合用时就在眼前，子代理与 Antigravity Orchestrator/Swarm 同树展开。文件与终端标签可排序，也可在主区和侧栏之间移动。",
      dispatchNote: "接入外部委派工具后，派单图也会显示委派任务；没有接入时，显示各家原生子代理与 Antigravity Orchestrator/Swarm 动态。",
      phoneTitle: "离开电脑，也能把住方向。",
      phoneText: "经 Tailscale 连回电脑，批准工具调用、回答提问、查看四家额度并浏览文件。未确认输入可恢复，视图加载失败可重试，表格内容自动换行。",
      terminalNote: "添加到主屏幕，就能像 App 一样打开。远程终端默认关闭，可随时在「设置 → 主机」切换。",
      demoNote: "截图来自使用演示数据的本地实例，其中的会话和路径均为虚构。",
      howTitle: "你的浏览器，连回你的电脑。",
      howIntro: "一个 Node 进程，官方 CLI，沿用已有的登录。",
      howText: "本机浏览器直连回环地址。其他设备先加入你的 tailnet，再由 Tailscale Serve 转发到 AIReins 的远程入口；入口检查 Host/Origin，只放行白名单中的 Tailscale 登录。本机 Node 进程通过 stream-json、ACP 与 codex app-server 驱动四家官方 CLI。",
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
      startText: "一条命令完成安装和构建；前置条件和远程配置见 README。",
      copy: "复制",
      copied: "已复制",
      copyFailed: "复制失败",
      platforms: "支持 Windows + WSL2、原生 Linux。macOS 为实验性支持，仅有 CI 覆盖。",
      startButton: "前往 README，开始使用",
      release: "v0.6.0 · 更新说明",
      license: "代码：MIT 许可证",
      notice: "名称与标志：见 NOTICE",
      description: "AI 尽管往前跑，缰绳始终在你手里。跑在自己电脑上的 Claude Code、Antigravity、Codex 和 Kimi Code 工作台，电脑和手机都能用。",
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
  const installCommand = "git clone https://github.com/yxhuang/AIReins.git && cd AIReins && bash install.sh";
  let currentLanguage = "en";
  let copyTimer = null;

  function initialLanguage() {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === "en" || saved === "zh") return saved;
    } catch { /* Browser storage may be disabled. */ }
    return (navigator.language || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
  }

  function setLanguage(language) {
    currentLanguage = language;
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
    const copyButton = document.querySelector("[data-copy-install]");
    if (copyButton && copyButton.dataset.copied === "true") {
      copyButton.textContent = copy.copied;
    }
    document.querySelector('meta[name="description"]').content = copy.description;
    document.querySelector('meta[property="og:description"]').content = copy.description;
    document.querySelector('meta[name="twitter:description"]').content = copy.description;
  }

  function fallbackCopy(text) {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    document.body.removeChild(area);
    return ok;
  }

  const copyButton = document.querySelector("[data-copy-install]");
  if (copyButton) {
    copyButton.addEventListener("click", async () => {
      let ok = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(installCommand);
          ok = true;
        } else {
          ok = fallbackCopy(installCommand);
        }
      } catch {
        ok = fallbackCopy(installCommand);
      }
      if (copyTimer) clearTimeout(copyTimer);
      copyButton.dataset.copied = ok ? "true" : "false";
      copyButton.textContent = ok ? messages[currentLanguage].copied : messages[currentLanguage].copyFailed;
      copyTimer = setTimeout(() => {
        copyButton.dataset.copied = "false";
        copyButton.textContent = messages[currentLanguage].copy;
        copyTimer = null;
      }, 1800);
    });
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
