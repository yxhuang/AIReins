import { useSyncExternalStore } from "react";
import { store } from "./store";

// 组件统一通过这个 hook 订阅 store；读取时直接访问 store 字段。
export function useStore() {
  useSyncExternalStore(store.subscribe, () => store.version);
  return store;
}
