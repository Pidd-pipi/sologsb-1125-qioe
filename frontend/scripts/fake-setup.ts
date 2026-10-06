// 必须在导入任何 Dexie 实例之前执行：ES import 按源顺序求值，
// 本文件在 verify-versioning.ts 中排第一即可先于 src/db 生效。
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

/** 单一 IDB 工厂：应用代码与测试清理必须共用同一实例 */
export const testFactory = new IDBFactory();

(globalThis as any).indexedDB = testFactory;
(globalThis as any).IDBKeyRange = IDBKeyRange;
(globalThis as any).BroadcastChannel = class {
  postMessage() {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
};
