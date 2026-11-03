'use strict';
/**
 * 极简 ZIP 打包器（零依赖，只吃 Node 内置 zlib）
 *
 * 为什么自己写：这个项目刻意不用任何 npm 包，换电脑时解压即跑，
 * 不必先联网 npm install。ZIP 格式本身不复杂，store + deflate 两种方式够用。
 *
 * 只支持：单层目录名、UTF-8 文件名、无加密、无 ZIP64（单包 < 4GB，写作数据远够）。
 */

const zlib = require('node:zlib');

// CRC32 查表，标准多项式 0xEDB88320
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

/** 把日期变成 DOS 时间戳（ZIP 用的那套，1980 年起） */
function dosDateTime(d) {
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date: date & 0xffff, time: time & 0xffff };
}

/**
 * @param {Array<{name: string, data: Buffer|string}>} files
 * @param {Date} [when]
 * @returns {Buffer} 完整的 zip 二进制
 */
function makeZip(files, when) {
  const stamp = dosDateTime(when || new Date());
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const crc = crc32(raw);

    // 压不动就原样存（已经压缩过的图片之类）
    let body = zlib.deflateRawSync(raw, { level: 6 });
    let method = 8;
    if (body.length >= raw.length) {
      body = raw;
      method = 0;
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // flag：文件名是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); // 中央目录头签名
    cen.writeUInt16LE(20, 4); // 制作版本
    cen.writeUInt16LE(20, 6); // 解压所需版本
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(stamp.time, 12);
    cen.writeUInt16LE(stamp.date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30); // extra
    cen.writeUInt16LE(0, 32); // comment
    cen.writeUInt16LE(0, 34); // disk
    cen.writeUInt16LE(0, 36); // internal attrs
    cen.writeUInt32LE(0, 38); // external attrs
    cen.writeUInt32LE(offset, 42);

    centralParts.push(cen, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // 目录结束签名
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, central, end]);
}

module.exports = { makeZip, crc32 };
