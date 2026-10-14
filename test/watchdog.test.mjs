import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const guard = join(rootDir, 'watchdog.sh');
const service = join(rootDir, 'service.sh');

test('守护只做租约恢复：不读电池、不写充电节点', () => {
  const svc = readFileSync(service, 'utf8');
  const wd = readFileSync(guard, 'utf8');
  const liveCommands = svc.split('\n').filter(s => !s.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(liveCommands, /\bpkill\b|\bkill\s+-9\b|force_active|force_val/);
  assert.match(svc, /--watch/);
  // 旧观察引擎与其调试入口必须已移除。
  assert.doesNotMatch(wd, /\bpidof\b|dumpsys|OBSERVATION_ONLY|ORPHAN|force_val|--once|--fixture/);
  assert.match(wd, /charge-test\.sh" --recover/);
  execFileSync('sh', ['-n', guard], { timeout: 3000 });
});