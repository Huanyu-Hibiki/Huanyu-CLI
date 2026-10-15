import { t } from './i18n.js';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { CliError } from './io.js';

// tar.gz 流式验证器：发布端打包后自检与安装端解压前预检共用（设计「publish 管道」的对称验证）。
const archiveError = () => new CliError(t('invalidArchive'), 1, 'invalid_archive');
const string = (buffer) => buffer.toString('utf8').split('\0')[0];

function tarNumber(buffer) {
  // GNU base-256 与标准八进制。
  if (buffer[0] & 0x80) {
    if (buffer[0] !== 0x80) throw archiveError();
    let value = 0n;
    for (const byte of buffer.subarray(1)) value = value * 256n + BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw archiveError();
    return Number(value);
  }
  const text = string(buffer).trim();
  if (!/^[0-7]+$/.test(text)) throw archiveError();
  const value = parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw archiveError();
  return value;
}

function paxFields(buffer) {
  const fields = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(32, offset);
    if (space < 0) throw archiveError();
    const sizeText = buffer.subarray(offset, space).toString();
    if (!/^[1-9]\d*$/.test(sizeText)) throw archiveError();
    const size = Number(sizeText), end = offset + size;
    if (!Number.isSafeInteger(size) || end > buffer.length || end <= space + 1 || buffer[end - 1] !== 10) throw archiveError();
    const record = buffer.subarray(space + 1, end - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals < 1) throw archiveError();
    const key = record.slice(0, equals);
    // 不接受会改变数据布局或链接行为的扩展。
    if (key === 'size' || key === 'linkpath' || /sparse/i.test(key)) throw archiveError();
    fields[key] = record.slice(equals + 1);
    offset = end;
  }
  return fields;
}

// 解压后总量上限（默认 400MB，与发布侧 RAW_SIZE_LIMIT/设计「假设清单」#2 对称）：
// tar 炸弹靠 entry 声明 size 之和在预检阶段拒绝，不落到磁盘。maxTotalBytes 供测试注入小阈值。
const DEFAULT_MAX_TOTAL_BYTES = 400 * 1024 * 1024;

// 在系统 tar 解压前流式检查所有实际条目，避免路径穿越及软/硬链接。
export async function validateArchive(file, name, platform = process.platform, maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES) {
  const input = createReadStream(file);
  const unzip = createGunzip();
  input.on('error', (error) => unzip.destroy(error));
  input.pipe(unzip);
  let buffer = Buffer.alloc(0), remaining = 0, padding = 0, metaType = null, meta = [], extended = {}, longName = null;
  let ended = false, count = 0, hasSkill = false, total = 0;
  const windowsEntries = new Set();
  try {
    for await (const chunk of unzip) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (ended) {
          if (buffer.some((byte) => byte !== 0)) throw archiveError();
          buffer = Buffer.alloc(0); break;
        }
        if (remaining) {
          const amount = Math.min(remaining, buffer.length);
          if (metaType) meta.push(buffer.subarray(0, amount));
          buffer = buffer.subarray(amount); remaining -= amount;
          if (remaining) break;
          if (metaType) {
            const payload = Buffer.concat(meta);
            if (metaType === 'L') longName = string(payload).replace(/\n$/, '');
            else {
              const fields = paxFields(payload);
              if (metaType === 'g' && fields.path) throw archiveError();
              if (metaType === 'x') extended = { ...extended, ...fields };
            }
            metaType = null; meta = [];
          }
        }
        if (padding) {
          const amount = Math.min(padding, buffer.length);
          buffer = buffer.subarray(amount); padding -= amount;
          if (padding) break;
        }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512); buffer = buffer.subarray(512);
        if (header.every((byte) => byte === 0)) { ended = true; continue; }
        const checksum = tarNumber(header.subarray(148, 156));
        const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
        if (checksum !== sum) throw archiveError();
        const size = tarNumber(header.subarray(124, 136));
        const type = String.fromCharCode(header[156] || 48);
        remaining = size; padding = (512 - size % 512) % 512;
        if (['x', 'g', 'L'].includes(type)) {
          if (size === 0 || size > 1024 * 1024) throw archiveError();
          metaType = type; continue;
        }
        if (!['0', '5'].includes(type)) throw archiveError();
        let entry = string(header.subarray(0, 100));
        const prefix = string(header.subarray(345, 500));
        if (prefix && string(header.subarray(257, 263)) === 'ustar') entry = `${prefix}/${entry}`;
        entry = extended.path || longName || entry;
        extended = {}; longName = null;
        while (entry.startsWith('./')) entry = entry.slice(2);
        const parts = entry.replace(/\/$/, '').split('/');
        if (!entry || entry.includes('\\') || /[\0\r\n]/.test(entry) || parts[0] !== name || parts.some((part) => !part || part === '..' || part === '.') || (parts.length === 1 && type !== '5')) throw archiveError();
        if (platform === 'win32') {
          // 拒绝盘符/ADS、设备名、尾部点空格和大小写碰撞，避免 Windows 把不同条目映射到同一路径。
          if (parts.some((part) => /[<>:"|?*\x00-\x1f]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw archiveError();
          const key = parts.join('/').toLowerCase();
          if (windowsEntries.has(key)) throw archiveError();
          windowsEntries.add(key);
        }
        if (type === '5' && size !== 0) throw archiveError();
        if (entry === `${name}/SKILL.md` && type === '0') hasSkill = true;
        count++;
        total += size;
        if (total > maxTotalBytes) throw archiveError();
      }
    }
    if (remaining || padding || buffer.length || !ended || !count || !hasSkill || metaType || longName || Object.keys(extended).length) throw archiveError();
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw archiveError();
  } finally { input.destroy(); unzip.destroy(); }
}

// 目录树里只允许普通文件与目录：符号链接/junction 等在打包或安装前就地拒绝。
export async function checkTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await checkTree(path.join(directory, entry.name));
    else if (!entry.isFile()) throw archiveError();
  }
}
