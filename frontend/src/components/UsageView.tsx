import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { store } from "../store";
import type { UsageProvider, UsageProviderId, UsageResetCredits, UsageSettingsPatch, UsageWindow } from "../types";
import {
  barLevel,
  formatClockTime,
  formatCreditExpiry,
  formatUsageAgo,
  formatUsageError,
  formatUsageReset,
  formatUsageWindowLabel,
  formatUsageWindowNote,
  groupUsageWindows,
  pacePct,
  USAGE_PROVIDER_ORDER,
} from "../usage";
import { useStore } from "../useStore";
import { AgentIcon } from "./AgentIcon";
import { CodexResetCard } from "./CodexResets";

const PROVIDER_TITLES: Record<UsageProviderId, string> = {
  claude: "Claude",
  antigravity: "Antigravity",
  codex: "Codex",
  kimi: "Kimi",
};

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function UsageWindowRow({ window: w, now }: { window: UsageWindow; now: number }) {
  const used = Math.min(100, Math.max(0, w.used_pct));
  const level = barLevel(w.used_pct);
  const pace = pacePct(w, now);
  const reset = formatUsageReset(w, now);
  const note = formatUsageWindowNote(w);
  const footParts = [reset?.text, note].filter((part): part is string => Boolean(part));

  return (
    <div className="usage-window">
      <div className="usage-window-row">
        <span className="usage-window-label">{formatUsageWindowLabel(w)}</span>
        <div className="usage-bar">
          <div
            className={`usage-bar-fill${level ? ` ${level}` : ""}`}
            style={{ width: `${used}%` }}
          />
          {pace !== null && (
            <div
              className="usage-pace"
              style={{ left: `${pace}%` }}
              title={t("ui.UsageView.pace_title", { pace: Math.round(pace) })}
            />
          )}
        </div>
        <span className="usage-window-pct">{Math.round(w.used_pct)}%</span>
      </div>
      {footParts.length > 0 && (
        <div className="usage-window-reset" title={reset?.title}>
          {footParts.join(" · ")}
        </div>
      )}
    </div>
  );
}

function UsageResetCreditsBlock({
  providerId,
  resetCredits,
  now,
  openSet,
}: {
  providerId: UsageProviderId;
  resetCredits: UsageResetCredits | null;
  now: number;
  openSet: Set<string>;
}) {
  const [, forceUpdate] = useState(0);
  if (!resetCredits || resetCredits.available_count <= 0) return null;
  const { available_count: count, credits } = resetCredits;
  if (!credits || credits.length === 0) {
    return <div className="usage-window-reset usage-reset-credit">{t("ui.UsageView.credits_count_only", { count })}</div>;
  }
  const first = formatCreditExpiry(credits[0]!, now);
  if (count === 1 && credits.length === 1) {
    const prefix = credits[0]!.title ? `${credits[0]!.title} · ` : "";
    return (
      <div className={`usage-window-reset usage-reset-credit${first.warn ? " warn" : ""}`}>
        {`🎫 ${prefix}${first.text}`}
      </div>
    );
  }
  const isOpen = openSet.has(providerId);
  return (
    <details
      className="usage-reset-credits"
      open={isOpen}
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open) openSet.add(providerId);
        else openSet.delete(providerId);
        forceUpdate((v) => v + 1);
      }}
    >
      <summary className={`usage-window-reset usage-reset-credit${first.warn ? " warn" : ""}`}>
        {t("ui.UsageView.credits_summary", { count, first: first.text })}
      </summary>
      {credits.map((credit, idx) => {
        const exp = formatCreditExpiry(credit, now);
        const prefix = credit.title ? `${credit.title} · ` : "";
        return (
          <div key={idx} className={`usage-window-reset usage-reset-credit${exp.warn ? " warn" : ""}`}>
            {`${prefix}${exp.text}`}
          </div>
        );
      })}
      {credits.length < count && (
        <div className="usage-window-reset usage-reset-credit">
          {t("ui.UsageView.credits_partial", { shown: credits.length, total: count })}
        </div>
      )}
    </details>
  );
}

function UsageProviderCard({
  provider,
  refreshing,
  now,
  kimiEnv,
  openCredits,
  onOpenKimiSettings,
}: {
  provider: UsageProvider;
  refreshing: boolean;
  now: number;
  kimiEnv: string;
  openCredits: Set<string>;
  onOpenKimiSettings: () => void;
}) {
  const ago = formatUsageAgo(provider.fetched_at, now);
  const failed = provider.status === "error" || provider.status === "auth_expired";
  const groups = groupUsageWindows(provider.windows, provider.id);

  return (
    <section className="usage-card" data-provider={provider.id} aria-label={provider.name} aria-busy={refreshing}>
      <div className="usage-card-head">
        <span className="usage-card-title">
          <AgentIcon agent={provider.id} label={provider.name} />
          <span className="usage-card-name">{provider.name}</span>
        </span>
        {provider.plan && <span className="usage-card-plan">{provider.plan}</span>}
        {provider.status === "stale" && ago && (
          <span className="usage-card-stale">{t("ui.UsageView.stale_from", { ago })}</span>
        )}
        {failed && ago && (
          <span className="usage-card-stale">{t("ui.UsageView.last_attempt", { ago })}</span>
        )}
        <button
          type="button"
          className="usage-refresh-btn usage-card-refresh"
          disabled={refreshing}
          aria-label={t(refreshing ? "ui.UsageView.refreshing_provider" : "ui.UsageView.refresh_provider", { provider: provider.name })}
          onClick={() => void store.refreshAllUsage(provider.id)}
        >
          {t(refreshing ? "ui.UsageView.refreshing" : "ui.UsageView.refresh")}
        </button>
      </div>

      {failed ? (
        <div className="usage-card-error">
          <span>{formatUsageError(provider, kimiEnv)}</span>
          {provider.error_code === "kimi_no_key" && (
            <button type="button" className="btn usage-inline-btn" onClick={onOpenKimiSettings}>
              {t("ui.UsageView.configure_kimi_key")}
            </button>
          )}
        </div>
      ) : (
        <>
          {provider.status === "stale" && (provider.error || provider.error_code) && (
            <div className="usage-card-error">{formatUsageError(provider, kimiEnv)}</div>
          )}
          {groups.map((grp, gIdx) => (
            <div key={grp.group ?? gIdx} className="usage-group">
              {grp.group && <div className="usage-group-title">{grp.group}</div>}
              {grp.items.map((w) => (
                <UsageWindowRow key={w.id} window={w} now={now} />
              ))}
            </div>
          ))}
        </>
      )}
      {provider.credits_note && (
        <div className="usage-window-reset usage-credits-balance">
          {t("ui.UsageView.credits_balance", { credits: provider.credits_note })}
        </div>
      )}
      {!failed && (
        <UsageResetCreditsBlock
          providerId={provider.id}
          resetCredits={provider.reset_credits}
          now={now}
          openSet={openCredits}
        />
      )}
    </section>
  );
}

export function UsageView({ onCollapse }: { onCollapse?: () => void }) {
  const summary = useStore((v) => v.usageSummary);
  const settings = useStore((v) => v.usageSettings);
  const loading = useStore((v) => v.usageLoading);
  const refreshingProviders = useStore((v) => v.usageRefreshing);
  const refreshing = refreshingProviders.size > 0;
  const usageError = useStore((v) => v.usageError);
  const now = useStore((v) => v.now);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [kimiKeyDraft, setKimiKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const gearBtnRef = useRef<HTMLButtonElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const openCreditsRef = useRef(new Set<string>());

  useEffect(() => {
    void store.loadUsage(true);
  }, []);

  useEffect(() => {
    if (settingsOpen && (!settings || (summary?.instance_id && settings.instance_id && settings.instance_id !== summary.instance_id))) {
      void store.loadUsageSettings();
    }
  }, [settingsOpen, settings, summary?.instance_id]);

  useEffect(() => {
    if (!settingsOpen || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (typeof document !== "undefined" && document.querySelector('[aria-modal="true"], dialog[open]')) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setSettingsOpen(false);
      requestAnimationFrame(() => gearBtnRef.current?.focus());
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [settingsOpen]);

  const openKimiSettings = () => {
    setSettingsOpen(true);
    void store.loadUsageSettings().then(() => {
      requestAnimationFrame(() => keyInputRef.current?.focus());
    });
  };

  const updateSettings = async (patch: UsageSettingsPatch) => {
    if (saving) return;
    setSaving(true);
    setSettingsError("");
    try {
      await store.updateUsageSettings(patch);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const saveKimiKey = async (clear = false) => {
    if (saving) return;
    const nextValue = clear ? null : kimiKeyDraft.trim();
    if (!clear && !nextValue) return;
    setSaving(true);
    setSettingsError("");
    try {
      await store.updateUsageSettings({ kimi: { apiKey: nextValue } });
      setKimiKeyDraft("");
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const providers = summary?.providers ?? [];
  const allDisabled = settings !== null && USAGE_PROVIDER_ORDER.every((id) => !settings.providers[id]?.enabled);
  const kimiEnv = settings?.kimi.apiKeyEnv ?? "KIMI_API_KEY";
  const kimiStatusText = !settings
    ? ""
    : settings.kimi.keySource === "config"
      ? t("ui.UsageView.kimi_key_status_config")
      : settings.kimi.keySource === "env"
        ? t("ui.UsageView.kimi_key_status_env", { env: settings.kimi.apiKeyEnv })
        : settings.kimi.keySource === "file"
          ? t("ui.UsageView.kimi_key_status_file")
          : t("ui.UsageView.kimi_key_status_none");

  return (
    <div
      className="usage-view"
      onKeyDown={(event) => {
        if (event.key === "Escape" && settingsOpen) {
          event.preventDefault();
          event.stopPropagation();
          setSettingsOpen(false);
          requestAnimationFrame(() => gearBtnRef.current?.focus());
        } else if (event.key === "Escape" && onCollapse && !event.defaultPrevented) {
          event.preventDefault();
          onCollapse();
        }
      }}
    >
      <div className="usage-scroll">
      <header className="usage-header">
        <button
          ref={gearBtnRef}
          type="button"
          className={`usage-gear${settingsOpen ? " active" : ""}`}
          title={t("ui.UsageView.settings_button")}
          aria-label={t("ui.UsageView.settings_button")}
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((v) => !v)}
        >
          <GearIcon />
        </button>
        <h2 className="usage-title">{t("ui.UsageView.title")}</h2>
        <div className="usage-header-right">
          <span className="usage-updated">
            {summary?.updated_at
              ? t("ui.UsageView.updated_at", { time: formatClockTime(summary.updated_at) })
              : t("ui.UsageView.no_data")}
          </span>
          <button
            type="button"
            className="usage-refresh-btn"
            disabled={refreshing || allDisabled}
            onClick={() => void store.refreshAllUsage()}
          >
            {t(refreshing ? "ui.UsageView.refreshing" : "ui.UsageView.refresh_all")}
          </button>
        </div>
      </header>

      {settingsOpen && (
        <section className="usage-settings" aria-label={t("ui.UsageView.settings_button")}>
          <div className="usage-settings-group">
            <div className="usage-settings-heading">{t("ui.UsageView.providers_heading")}</div>
            <div className="usage-provider-toggles">
              {USAGE_PROVIDER_ORDER.map((id) => {
                const enabled = settings ? settings.providers[id]?.enabled !== false : true;
                return (
                  <label key={id} className="usage-toggle-chip">
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={saving || !settings}
                      onChange={(e) => void updateSettings({ providers: { [id]: { enabled: e.currentTarget.checked } } })}
                    />
                    <AgentIcon agent={id} label={PROVIDER_TITLES[id]} />
                    <span>{PROVIDER_TITLES[id]}</span>
                  </label>
                );
              })}
            </div>
            <p className="usage-setting-note">{t("ui.UsageView.antigravity_on_demand_note")}</p>
            <label className="usage-setting-row">
              <input
                type="checkbox"
                checked={settings?.antigravity?.includeCredits === true}
                disabled={saving || !settings?.antigravity}
                onChange={(e) => void updateSettings({ antigravity: { includeCredits: e.currentTarget.checked } })}
              />
              <span>{t("ui.UsageView.antigravity_include_credits")}</span>
            </label>
          </div>

          <div className="usage-settings-group">
            <div className="usage-settings-heading-row">
              <span className="usage-settings-heading">{t("ui.UsageView.kimi_key_heading")}</span>
              {kimiStatusText && <span className="usage-key-status">{kimiStatusText}</span>}
            </div>
            <form
              className="usage-key-form"
              onSubmit={(e) => {
                e.preventDefault();
                void saveKimiKey(false);
              }}
            >
              <input
                ref={keyInputRef}
                type="password"
                className="usage-key-input"
                autoComplete="off"
                spellCheck={false}
                value={kimiKeyDraft}
                onChange={(e) => setKimiKeyDraft(e.currentTarget.value)}
                placeholder={t("ui.UsageView.kimi_key_placeholder")}
                aria-label={t("ui.UsageView.kimi_key_heading")}
                disabled={saving}
              />
              <div className="usage-key-actions">
                <button
                  type="submit"
                  className="btn btn-primary usage-small-btn"
                  disabled={saving || !kimiKeyDraft.trim()}
                >
                  {t("ui.UsageView.kimi_key_save")}
                </button>
                {settings?.kimi.keySource === "config" && (
                  <button
                    type="button"
                    className="btn usage-small-btn"
                    disabled={saving}
                    onClick={() => void saveKimiKey(true)}
                  >
                    {t("ui.UsageView.kimi_key_clear")}
                  </button>
                )}
              </div>
            </form>
            <label className="usage-setting-row">
              <input
                type="checkbox"
                checked={settings?.kimi.useProxy === true}
                disabled={saving || !settings}
                onChange={(e) => void updateSettings({ kimi: { useProxy: e.currentTarget.checked } })}
              />
              <span>{t("ui.UsageView.kimi_proxy")}</span>
            </label>
          </div>

          {settingsError && <p className="usage-error-banner" role="alert">{settingsError}</p>}
        </section>
      )}

      {usageError && (
        <div className="usage-error-banner" role="alert">
          {summary ? t("ui.UsageView.fetch_failed_keep_last", { reason: usageError }) : usageError}
        </div>
      )}

      <div className="usage-cards" aria-busy={providers.length === 0 && (loading || refreshing)}>
        {allDisabled ? (
          <p className="usage-empty">{t("ui.UsageView.all_disabled")}</p>
        ) : providers.length === 0 ? (
          <p className="usage-empty" role="status">
            {t(loading || refreshing ? "ui.UsageView.empty_loading" : "ui.UsageView.empty_idle")}
          </p>
        ) : (
          providers.map((p) => (
            <UsageProviderCard
              key={p.id}
              provider={p}
              refreshing={refreshingProviders.has(p.id)}
              now={now}
              kimiEnv={kimiEnv}
              openCredits={openCreditsRef.current}
              onOpenKimiSettings={openKimiSettings}
            />
          ))
        )}
      </div>
      </div>

      <CodexResetCard />
    </div>
  );
}
