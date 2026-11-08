/** 进程起停类事件：推进 lastActivityAt，但不结束侧栏手动排序位置（前后端共用，保持一致）。 */
export const LIFECYCLE_EVENTS: ReadonlySet<string> = new Set(["worker_released", "process_exited", "remote_control_updated", "background_tasks_updated"]);
