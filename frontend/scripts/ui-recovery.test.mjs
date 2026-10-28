import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mountModalFocus, modalReturnTargets } from "../src/components/modal-focus.ts";
import { PanelErrorBoundary, PanelLoadFailure, RecoverableLazy } from "../src/components/RecoverableLazy.tsx";
import { renderSettled } from "./render-settled.mjs";

globalThis.React = React;

// Minimal event-driven DOM double: exercise keyboard/focus transitions without a
// browser, runtime dependencies, logged-in CLIs or built frontend assets.
const listeners = new Map();
const dispatch = (name, event = {}) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(event); };
class Element {
  constructor(name, parent = null, control = false) {
    this.name = name; this.parentElement = parent; this.children = []; this.control = control;
    this.hidden = false; this.disabled = false; this.role = ""; this.menuTrigger = false;
    parent?.children.push(this);
  }
  get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  getClientRects() { return this.closest("[hidden]") ? [] : [{}]; }
  matches(selector) { return selector === ":disabled" && this.disabled; }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (selector === '[role="menu"]' ? node.role === "menu" : node.hidden) return node;
    }
    return null;
  }
  querySelectorAll() { return this.children.flatMap(child => [...(child.control && !child.disabled ? [child] : []), ...child.querySelectorAll()]); }
  querySelector() { return this.children.find(child => child.menuTrigger) ?? null; }
  focus() { if (!this.disabled) { document.activeElement = this; dispatch("focusin"); } }
}
globalThis.HTMLElement = Element;
globalThis.getComputedStyle = () => ({ visibility: "visible" });
globalThis.document = {
  activeElement: null,
  addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
  removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
};
document.body = new Element("body");
const body = document.body;
const opener = new Element("opener", body, true);
const dialog = new Element("dialog", body);
const first = new Element("close", dialog, true);
const last = new Element("select", dialog, true);
const hidden = new Element("hidden", dialog, true); hidden.hidden = true;
const disabled = new Element("disabled", dialog, true); disabled.disabled = true;
const tab = (shiftKey = false, defaultPrevented = false) => {
  const event = { key: "Tab", shiftKey, defaultPrevented, preventDefault() { this.defaultPrevented = true; } };
  dispatch("keydown", event); return event;
};
opener.focus();
const stop = mountModalFocus(dialog, first, modalReturnTargets(document.activeElement));
assert.equal(document.activeElement, first);
tab(true); assert.equal(document.activeElement, last, "Shift+Tab skips hidden/disabled controls and wraps to the last control");
tab(); assert.equal(document.activeElement, first, "Tab wraps inside the modal");
last.focus(); opener.focus(); assert.equal(document.activeElement, last, "background focus is redirected");
last.disabled = true; opener.focus(); assert.equal(document.activeElement, first, "a control disabled during a native picker/request is not refocused"); last.disabled = false;
const nested = new Element("nested", body), nestedClose = new Element("nestedClose", nested, true);
const stopNested = mountModalFocus(nested, nestedClose, [first]);
tab(); assert.equal(document.activeElement, nestedClose, "only the innermost dialog handles Tab");
stopNested(); assert.equal(document.activeElement, first, "nested close returns to the parent dialog");
stop(); assert.equal(document.activeElement, opener, "closing returns focus to the opening control");
assert.equal([...listeners.values()].reduce((total, set) => total + set.size, 0), 0, "unmount removes document listeners");

const menuRoot = new Element("menuRoot", body);
const trigger = new Element("trigger", menuRoot, true); trigger.menuTrigger = true;
const menu = new Element("menu", menuRoot); menu.role = "menu";
const item = new Element("item", menu, true); item.focus();
const returnTargets = modalReturnTargets(item);
menu.parentElement = null;
const stopMenuDialog = mountModalFocus(dialog, first, returnTargets);
stopMenuDialog(); assert.equal(document.activeElement, trigger, "a removed menu item falls back to its persistent menu trigger");
const empty = new Element("empty", body);
const stopEmpty = mountModalFocus(empty, null, [opener]);
assert.equal(document.activeElement, empty); assert.ok(tab().defaultPrevented); stopEmpty();
delete globalThis.document;

// Drive the real retry callback through controlled hook state. Actual lazy promise
// rejection/resolution is handled by React SSR; the error boundary state is tested
// separately because React's server renderer does not invoke client error boundaries.
let calls = 0, hookState;
const load = async () => { calls++; if (calls === 1) throw new Error("chunk unavailable"); return { default: () => React.createElement("p", null, "recovered panel") }; };
const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const previous = internals.H;
const props = { load, componentProps: {}, label: "Panel", onClose() {} };
const renderControlled = () => {
  internals.H = { useState(initial) { hookState ??= initial(); return [hookState, update => { hookState = update(hookState); }]; } };
  try { return RecoverableLazy(props); } finally { internals.H = previous; }
};
const failed = renderControlled();
await assert.rejects(renderSettled(failed), /chunk unavailable/);
const error = new Error("chunk unavailable");
const boundary = new PanelErrorBoundary(failed.props);
boundary.state = PanelErrorBoundary.getDerivedStateFromError(error);
const failure = boundary.render().props.children;
assert.match(renderToStaticMarkup(failure), /role="alert"/);
failure.props.onRetry();
const retry = renderControlled();
assert.notEqual(retry.key, failed.key);
assert.notEqual(retry.props.children.props.children.type, failed.props.children.props.children.type, "retry discards React.lazy's cached rejection");
assert.match(await renderSettled(retry), /recovered panel/);
assert.equal(calls, 2, "retry invokes the loader again");
assert.match(await renderSettled(React.createElement(RecoverableLazy, props)), /recovered panel/);
assert.equal(calls, 2, "reopening a loaded panel reuses its module");

let confirmed = false, reloads = 0, closes = 0;
globalThis.window = { confirm: () => confirmed, location: { reload() { reloads++; } } };
const failureTree = PanelLoadFailure({ label: "Panel", error, onRetry() {}, onClose() { closes++; } });
const buttons = failureTree.props.children.at(-1).props.children;
buttons[1].props.onClick(); assert.equal(closes, 1); assert.equal(reloads, 0);
buttons[2].props.onClick(); assert.equal(reloads, 0, "canceling refresh preserves drafts and attachments");
confirmed = true; buttons[2].props.onClick(); assert.equal(reloads, 1);
assert.doesNotMatch(readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8"), /(?:location\.reload|vite:preloadError)/, "entry point never automatically reloads on chunk failure");
console.log("✅ modal keyboard loops, nested dialogs, picker recovery, focus return; rejected lazy retry, cached module reuse and explicit refresh confirmation");
