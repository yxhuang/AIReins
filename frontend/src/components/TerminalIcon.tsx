/** 侧栏与手机会话顶栏共用。 */
export function TerminalIcon() {
  return <span className="page-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <polyline points="6 9 9 12 6 15" />
      <line x1="12" y1="15" x2="18" y2="15" />
    </svg>
  </span>;
}
