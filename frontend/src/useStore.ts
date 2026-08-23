import { useCallback, useRef, useSyncExternalStore } from "react";
import { store, type Store } from "./store";

export type StoreSelector<T> = (value: Store) => T;
export type EqualityFn<T> = (previous: T, next: T) => boolean;

/** 小型 tuple / 派生对象的逐项比较；字段应只放原始值或稳定引用。 */
export function shallowEqual<T>(previous: T, next: T): boolean {
  if (Object.is(previous, next)) return true;
  if (!previous || !next || typeof previous !== "object" || typeof next !== "object") {
    return false;
  }
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  if (previousKeys.length !== nextKeys.length) return false;
  return previousKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(next, key) &&
      Object.is(
        (previous as Record<string, unknown>)[key],
        (next as Record<string, unknown>)[key],
      ),
  );
}

// 无参调用保持旧契约：订阅全局 version 并返回 store；性能敏感组件可选取最小快照。
export function useStore(): Store;
export function useStore<T>(selector: StoreSelector<T>, isEqual?: EqualityFn<T>): T;
export function useStore<T>(
  selector?: StoreSelector<T>,
  isEqual: EqualityFn<T> = Object.is,
): Store | T {
  // selector 常捕获 session id，引用可能随 render 改变；ref 让 getSnapshot 自身保持稳定，
  // 同时用相等判定复用上次快照，避免派生 tuple 每次 notify 都制造新引用。
  const selectorRef = useRef(selector);
  const equalityRef = useRef(isEqual);
  const selectedRef = useRef<{ hasValue: boolean; value?: T }>({ hasValue: false });
  selectorRef.current = selector;
  equalityRef.current = isEqual;

  const getSnapshot = useCallback((): number | T => {
    const select = selectorRef.current;
    if (!select) return store.version;
    const next = select(store);
    if (
      selectedRef.current.hasValue &&
      equalityRef.current(selectedRef.current.value as T, next)
    ) {
      return selectedRef.current.value as T;
    }
    selectedRef.current = { hasValue: true, value: next };
    return next;
  }, []);

  const selected = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
  return selector ? (selected as T) : store;
}
