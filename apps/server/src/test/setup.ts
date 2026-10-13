/**
 * 测试前置（每个 test 子进程都会执行一次）
 *
 * 为什么需要：测试文件 import 的模块会连带 import `src/db`，它按 `IDATE_DATA_DIR`
 * 打开 SQLite 并跑建表/migration。默认路径指向**生产库**（apps/server/data/infinite-date.sqlite），
 * 并行跑测试时会和生产后端 + 彼此抢写锁，报 `database is locked` 把测试进程整个打挂（实测）。
 *
 * 这里给每个子进程分配一个**独立临时库**：不碰生产库、并行也互不干扰，退出时自动清理。
 * 想在测试里看库内容：IDATE_TEST_KEEP=1 npm test
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.IDATE_TEST_KEEP) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `idate-test-${process.pid}-`));
  process.env.IDATE_DATA_DIR = dir;
  process.on('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败无所谓，/tmp 里的小文件 */
    }
  });
}
