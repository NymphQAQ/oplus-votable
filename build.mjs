#!/usr/bin/env node
/**
 * 生成 oplus-votable 自适应限流版 ZIP。
 * 包含模块配置、升级清理、租约守护、自适应限流与 WebUI。
 */
import { copyFileSync, chmodSync, existsSync, mkdirSync,
  mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const stage = mkdtempSync(join(tmpdir(), 'oplus-votable-build-'));
const expected = [
  'module.prop','service.sh','uninstall.sh','watchdog.sh',
  'charge-test.sh','customize.sh',
  'webroot/index.html','webroot/app.js','webroot/log-utils.js',
  'webroot/log-reader.sh',
];
const output = join(root, 'dist', 'oplus-votable-0.8.8-protocol-defaults.zip');
try {
  mkdirSync(join(stage, 'package'));
  for (const name of expected) {
    const src = join(root,name);
    if (!existsSync(src) || !statSync(src).isFile()) {
      throw new Error('缺少打包文件 '+name);
    }
    const dest = join(stage,'package',name);
    mkdirSync(dirname(dest), {recursive:true});
    copyFileSync(src,dest);
    if (name.endsWith('.sh')) chmodSync(dest,0o755);
  }
  mkdirSync(dirname(output), {recursive:true});
  rmSync(output,{force:true});
  execFileSync('zip',['-X','-q',output,...expected],{
    cwd:join(stage,'package'), timeout:20000, stdio:'pipe',
  });
  const contents = execFileSync('unzip',['-Z','-1',output],{
    encoding:'utf8',timeout:10000,
  }).trim().split('\n').sort();
  if (JSON.stringify(contents)!==JSON.stringify([...expected].sort())) {
    throw new Error('包内文件列表与白名单不一致');
  }
  console.log('ZIP_BUILD_OK '+output);
  console.log('PACKAGE_CONTENTS '+contents.join(', '));
} finally {
  rmSync(stage,{recursive:true,force:true});
}
