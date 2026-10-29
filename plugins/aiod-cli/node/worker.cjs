// plugins/aiod-cli/node/worker.cjs —— 随包 Node 工作进程
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const MAX_OUTPUT = 256 * 1024;        // 单次输出采集上限（同时下发给 CLI 的 --max-output）
const MAX_OUTPUT_CAP = 800 * 1024;    // 留出余量，避开宿主单行 1MB 的硬上限
const MAX_LINE = 900 * 1024;          // 宿主单行 stdout 上限 1MB
const ARGV_LIMIT = 32000;             // Windows CreateProcess 命令行 32767 字符
const CHUNK_BYTES = 48 * 1024;        // write 分片
const MAX_CONTENT = 200 * 1000;       // 单次 write_file 内容上限（≈200KB，受 params 256KB 约束）

const NL = String.fromCharCode(10);

// 分页时每页都要算一次行数/字节数/行尾风格；本进程自己的写入会主动失效，外部命令一律全清
const metaCache = new Map();
const META_TTL_MS = 5000;
const uploads = new Map();
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const UPLOAD_TTL_MS = 30 * 60 * 1000;

function invalidateMeta(remote) {
  if (remote === undefined) metaCache.clear();
  else metaCache.delete(remote);
}

function log(msg) {
  process.stderr.write(`[aiod-worker] ${msg}\n`);
}

function reply(id, result, error) {
  const resp = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result };
  let line = JSON.stringify(resp);
  if (line.length > MAX_LINE) {
    line = JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32010, message: '返回内容超过单行上限；请调小 maxOutputBytes / maxBytes / maxLines 后重试' }
    });
  }
  process.stdout.write(line + '\n');
}

function getStandardPlatformKey() {
  const osMap = { darwin: 'macos', win32: 'windows', linux: 'linux' };
  const archMap = { x64: 'amd64', x86_64: 'amd64', arm64: 'arm64', aarch64: 'arm64' };
  const os = osMap[process.platform] || process.platform;
  const arch = archMap[process.arch] || process.arch;
  return `${os}-${arch}`;
}

function findBinary() {
  const isWin = process.platform === 'win32';
  const ext = isWin ? '.exe' : '';
  const exeName = `aiod-cli${ext}`;
  const binDir = path.resolve(__dirname, '..', 'bin');

  const flatBin = path.join(binDir, exeName);
  if (fs.existsSync(flatBin)) {
    try { fs.chmodSync(flatBin, 0o755); } catch (_) {}
    return flatBin;
  }

  const stdBin = path.join(binDir, getStandardPlatformKey(), exeName);
  if (fs.existsSync(stdBin)) {
    try { fs.chmodSync(stdBin, 0o755); } catch (_) {}
    return stdBin;
  }

  const platKey = `${process.platform}-${process.arch}`;
  const candidates = [
    path.join(binDir, platKey, exeName),
    path.join(binDir, `${process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`, exeName),
    path.resolve(__dirname, '..', exeName)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try { fs.chmodSync(c, 0o755); } catch (_) {}
      return c;
    }
  }

  return exeName;
}

function buildEnv(request) {
  const env = { ...process.env, ...(request.params?.env || {}) };
  const secretKey = request.cindy?.secrets?.sandbox_key;
  if (secretKey) env.SANDBOX_KEY = secretKey;
  return env;
}

// 把 spawn 的同步异常（如 ENAMETOOLONG）翻译成 agent 能直接照做的中文提示
function spawnFailure(err, argv) {
  const total = argv.reduce((n, a) => n + String(a).length + 1, 0);
  if (err && (err.code === 'ENAMETOOLONG' || err.code === 'E2BIG')) {
    return new Error(
      `命令行参数过长（约 ${total} 字符，Windows 上限 32767）：长内容不要内联进 argv，` +
      '请改用 aiod_write_file（内容走文件通道）或拆成更小片段。'
    );
  }
  if (err && err.code === 'ENOENT') {
    return new Error(`找不到可执行的 aiod-cli：${err.message}`);
  }
  return new Error(`启动 aiod-cli 失败: ${(err && err.message) || err}`);
}

function runCli(bin, argv, env, maxOutput) {
  const requested = Math.min(Math.max(Number(maxOutput) || MAX_OUTPUT, 4096), MAX_OUTPUT_CAP);
  // 上游超限时会额外多给一点（截断提示/尾部），采集端留出余量，避免把它的尾巴切掉
  const cap = requested + 512;
  return new Promise((resolve, reject) => {
    const total = argv.reduce((n, a) => n + String(a).length + 1, 0);
    if (process.platform === 'win32' && total > ARGV_LIMIT) {
      reject(spawnFailure({ code: 'ENAMETOOLONG' }, argv));
      return;
    }
    let child;
    try {
      child = spawn(bin, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(spawnFailure(err, argv));
      return;
    }

    const outParts = [];
    const errParts = [];
    let outSize = 0;
    let errSize = 0;
    let outTotal = 0;
    let errTotal = 0;

    child.stdout.on('data', (chunk) => {
      outTotal += chunk.length;
      const part = outSize + chunk.length <= cap ? chunk : chunk.subarray(0, Math.max(cap - outSize, 0));
      if (part.length) {
        outParts.push(part);
        outSize += part.length;
      }
    });
    child.stderr.on('data', (chunk) => {
      errTotal += chunk.length;
      const part = errSize + chunk.length <= cap ? chunk : chunk.subarray(0, Math.max(cap - errSize, 0));
      if (part.length) {
        errParts.push(part);
        errSize += part.length;
      }
    });

    child.on('error', (err) => reject(spawnFailure(err, argv)));
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(outParts).toString('utf-8'),
        stdoutBuffer: Buffer.concat(outParts),
        stderr: Buffer.concat(errParts).toString('utf-8'),
        exitCode: code === null ? 1 : code, // 被信号杀死时 Node 给 null，按上游约定归一为 1
        stdoutBytes: outTotal,
        stderrBytes: errTotal,
        stdoutTruncated: outTotal > outSize,
        stderrTruncated: errTotal > errSize
      });
    });
  });
}

// 上游截断时会单独占一行 “... output truncated ...”；按行锚定，避免普通输出误报
function hasTruncationMarker(text) {
  return /^\.\.\. output truncated \.\.\.$/m.test(text);
}

// 上游错误信封形如 HTTP 400: {"data":{"errno_name":"ENOENT",...}}；抽成人话
function failDetail(r) {
  const raw = (r.stderr || r.stdout || '').trim();
  if (!raw) return `exit ${r.exitCode}`;
  const head = raw.replace(/^HTTP \d+:\s*/, '').split('\n')[0];
  let parsed = null;
  try { parsed = JSON.parse(head); } catch (_) {}
  if (parsed && typeof parsed === 'object') {
    const data = parsed.data || {};
    const bits = [];
    for (const key of ['errno_name', 'error_type', 'exception_type']) {
      if (data[key] && !bits.includes(data[key])) bits.push(data[key]);
    }
    if (parsed.message) bits.push(parsed.message);
    if (data.path) bits.push(`path=${data.path}`);
    if (Array.isArray(parsed.errors) && parsed.errors[0]?.message) bits.push(parsed.errors[0].message);
    if (bits.length) return bits.join(' | ').slice(0, 300);
  }
  return head.slice(0, 300);
}

function withHint(detail) {
  if (/old_str not found/i.test(detail)) {
    return `${detail}；old 没找到：确认它没被改掉或存在空白差异；刚改过就先 aiod_read_file 核对当前内容，不要盲目重试`;
  }
  if (/EISDIR/i.test(detail)) return `${detail}；目标是目录，请指定文件路径`;
  if (/ENOENT|does not exist|Path does not exist/i.test(detail)) {
    return `${detail}；路径不存在，先 aiod_exec "ls -l <上级目录>" 确认`;
  }
  if (/within the range|validation failed/i.test(detail)) {
    return `${detail}；行号需落在 [0, 文件总行数] 之间`;
  }
  if (/already exists/i.test(detail)) return `${detail}；如需覆盖请传 overwrite:true`;
  return detail;
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function hashBuf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

function countLines(text) {
  if (!text) return 0;
  const parts = text.split(NL);
  return text.endsWith(NL) ? parts.length - 1 : parts.length;
}

function requireAbs(value, field) {
  const remote = String(value || '');
  if (!remote) throw new Error(`${field} 必填：沙箱内绝对路径，例如 /root/app.py`);
  if (!remote.startsWith('/')) {
    throw new Error(`${field} 必须是绝对路径（相对路径会被沙箱解析到 /workspace），当前值：${remote}`);
  }
  if (remote.split('/').some((s) => s === '..' || s === '.')) {
    throw new Error(`${field} 不要包含 . 或 .. 路径段（可能写出沙箱工作区之外），当前值：${remote}`);
  }
  return remote;
}

// 按 UTF-8 字节分片，绝不切断多字节字符
function splitContent(content, maxBytes) {
  const buf = Buffer.from(content, 'utf8');
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let end = Math.min(i + maxBytes, buf.length);
    while (end < buf.length && end > i && (buf[end] & 0xc0) === 0x80) end--;
    if (end === i) end = Math.min(i + maxBytes, buf.length);
    out.push(buf.subarray(i, end).toString('utf8'));
    i = end;
  }
  return out;
}

async function remoteSize(bin, env, remote) {
  const r = await runCli(bin, ['exec', `wc -c < ${shq(remote)}`], env);
  if (r.exitCode !== 0) return null;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// 行数、字节数、末字节、是否 CRLF 一次拿全：末字节不是换行时行数要 +1，分页才不会漏最后一行
async function fileMeta(bin, env, remote) {
  const hit = metaCache.get(remote);
  if (hit && Date.now() - hit.at < META_TTL_MS) return hit.meta;
  const q = shq(remote);
  const r = await runCli(bin, [
    'exec',
    `printf '%s|%s|%s|%s' "$(wc -l < ${q})" "$(wc -c < ${q})" "$(tail -c 1 ${q} | od -An -tx1 | tr -d ' \n')" "$(awk '{ if (substr($0, length($0), 1) == "\r") c++ } END { print c + 0 }' ${q})"`
  ], env);
  if (r.exitCode !== 0) return null;
  const [rawLines, rawBytes, lastByte, rawCrlf] = r.stdout.trim().split('|');
  const newlines = parseInt(rawLines, 10);
  const bytes = parseInt(rawBytes, 10);
  if (!Number.isFinite(newlines) || !Number.isFinite(bytes)) return null;
  const endsWithNewline = (lastByte || '').trim() === '0a';
  const crlfLines = parseInt(rawCrlf, 10) || 0;
  const totalLines = bytes === 0 ? 0 : newlines + (endsWithNewline ? 0 : 1);
  const meta = {
    totalBytes: bytes,
    totalLines,
    endsWithNewline,
    crlfLines,
    crlf: crlfLines > 0,
    // 混合行尾（部分 CRLF、部分 LF）：上游区间读取会丢掉区间末行的行尾，补偿只能靠
    // 文件级行尾风格猜；混合时必须改用 cat --exact（整文件读 + 本地切片）
    mixed: crlfLines > 0 && crlfLines < newlines
  };
  metaCache.set(remote, { meta, at: Date.now() });
  return meta;
}

// 某一行在文件里的字节偏移（0 基行号）
async function lineByteOffset(bin, env, remote, lineIndex) {
  if (lineIndex <= 0) return 0;
  const r = await runCli(bin, ['exec', `head -n ${lineIndex} ${shq(remote)} | wc -c`], env);
  if (r.exitCode !== 0) return null;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

async function remoteSha256(bin, env, remote) {
  const r = await runCli(bin, ['exec', `sha256sum ${shq(remote)}`], env);
  if (r.exitCode !== 0) return null;
  const token = r.stdout.trim().split(/\s+/)[0];
  return /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : null;
}

async function handleWriteFile(bin, env, p) {
  const remote = requireAbs(p.path, 'path');
  if (typeof p.content !== 'string') throw new Error('content 必须是字符串（文本内容；二进制请用 aiod_upload）');
  const content = p.content;
  const append = !!p.append;
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_CONTENT) {
    throw new Error(
      `content 为 ${bytes} 字节，超过单次上限 ${MAX_CONTENT} 字节：请分段写入，` +
      '首段省略 append，后续段传 append:true 追加'
    );
  }
  const before = await remoteSize(bin, env, remote);

  if (bytes === 0) {
    if (append) {
      if (before !== null) {
        return { path: remote, bytes: 0, chunks: 0, append: true, totalBytes: before, verified: true, note: 'append 空内容：文件未改动' };
      }
      const r = await runCli(bin, ['exec', `: > ${shq(remote)}`], env);
      if (r.exitCode !== 0) throw new Error(`创建空文件失败：${withHint(failDetail(r))}`);
      return { path: remote, bytes: 0, chunks: 0, append: true, totalBytes: 0, verified: true, overwrote: false, previousBytes: 0, note: 'append 空内容：目标不存在，已创建为空文件' };
    }
    const r = await runCli(bin, ['exec', `: > ${shq(remote)}`], env);
    if (r.exitCode !== 0) throw new Error(`创建空文件失败：${withHint(failDetail(r))}`);
    const after = await remoteSize(bin, env, remote);
    if (after !== 0) throw new Error(`创建空文件校验失败：沙箱实际 ${after === null ? '读不到文件' : after + ' 字节'}`);
    return {
      path: remote, bytes: 0, chunks: 0, append: false, totalBytes: 0, verified: true,
      overwrote: (before || 0) > 0, previousBytes: before || 0
    };
  }

  const chunks = splitContent(content, CHUNK_BYTES);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiod-write-'));
  try {
    for (let i = 0; i < chunks.length; i++) {
      const file = path.join(tmpDir, `chunk-${i}.txt`);
      fs.writeFileSync(file, chunks[i], 'utf8');
      const argv = append || i > 0 ? ['write', file, remote, '--append'] : ['write', file, remote];
      const r = await runCli(bin, argv, env);
      if (r.exitCode !== 0) {
        throw new Error(`第 ${i + 1}/${chunks.length} 片写入失败：${withHint(failDetail(r))}`);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const expected = (append ? before || 0 : 0) + bytes;
  const actual = await remoteSize(bin, env, remote);
  if (actual !== expected) {
    throw new Error(
      `写入校验失败：期望 ${expected} 字节（分 ${chunks.length} 片），沙箱实际 ${actual === null ? '读不到文件' : actual + ' 字节'}`
    );
  }

  const result = {
    path: remote,
    bytes,
    chunks: chunks.length,
    append,
    totalBytes: actual,
    verified: true,
    overwrote: append ? false : (before || 0) > 0,
    previousBytes: append ? undefined : before || 0
  };
  invalidateMeta(remote);
  if (!append) {
    result.sha256 = hashBuf(Buffer.from(content, 'utf8'));
    const remoteHash = await remoteSha256(bin, env, remote);
    result.sha256Match = remoteHash === null ? null : remoteHash === result.sha256;
    if (result.sha256Match === false) {
      throw new Error(`写入后 SHA256 不一致：本地 ${result.sha256}，沙箱 ${remoteHash}`);
    }
  }
  return result;
}

async function handleReadFile(bin, env, p) {
  const remote = requireAbs(p.path, 'path');
  const maxBytes = clamp(toInt(p.maxBytes, 65536), 1024, 200000);
  const maxLines = clamp(toInt(p.maxLines, 200), 1, 2000);
  const meta = await fileMeta(bin, env, remote);
  if (!meta) throw new Error(`读取失败：读不到 ${remote}（路径不存在或不是文件）`);

  // 字节模式：给超长单行（minified js、单行 JSON）留的完整读取通道
  if (p.startByte !== undefined && p.startByte !== null) {
    const startByte = clamp(toInt(p.startByte, 0), 0, Math.max(meta.totalBytes, 0));
    // 多取 4 字节，再用本地 UTF-8 边界收敛，避免把汉字/emoji 切成 U+FFFD
    const r = await runCli(bin, [
      'exec',
      `tail -c +${startByte + 1} ${shq(remote)} | head -c ${maxBytes + 4}`,
      `--max-output=${Math.max(maxBytes + 8, MAX_OUTPUT)}`
    ], env, maxBytes + 8192);
    if (r.exitCode !== 0) throw new Error(`读取失败：${withHint(failDetail(r))}`);

    const buf = r.stdoutBuffer;
    let cut = Math.min(maxBytes, buf.length);
    if (cut < buf.length) {
      while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut -= 1;
      if (cut === 0) cut = Math.min(maxBytes, buf.length);
    }
    const content = buf.subarray(0, cut).toString('utf8');
    const nextByteStart = startByte + cut;
    return {
      path: remote,
      mode: 'byte',
      startByte,
      maxBytes,
      bytes: cut,
      content,
      nextByteStart,
      totalBytes: meta.totalBytes,
      totalLines: meta.totalLines,
      hasMore: nextByteStart < meta.totalBytes
    };
  }

  // 行模式：先算起始行（支持 tail:N 直接看末尾）
  let startLine = clamp(toInt(p.startLine, 0), 0, 100000000);
  const tail = Math.max(0, toInt(p.tail, 0));
  if (tail > 0) startLine = Math.max(0, meta.totalLines - tail);
  const catCap = Math.max(maxBytes + 8, MAX_OUTPUT);
  // 混合行尾 / 显式 exact 时用 --exact：整文件读取后本地切片，行尾逐字节精确
  const EXACT_MAX_BYTES = 6 * 1024 * 1024; // 上游 cat --exact 受 8MiB 响应缓冲限制，留足余量
  let useExact = !!p.exact || meta.mixed;
  let exactNote;
  if (useExact && meta.totalBytes > EXACT_MAX_BYTES) {
    if (p.exact) {
      throw new Error(
        `exact 模式需要整文件读取，当前文件 ${meta.totalBytes} 字节超过 ${EXACT_MAX_BYTES} 字节上限：` +
        '请改用默认区间模式（大文件混合行尾时页末行尾可能被归一化），或先 aiod_download 到本机处理'
      );
    }
    useExact = false;
    exactNote = `文件 ${meta.totalBytes} 字节超过 exact 上限，已回退区间模式：混合行尾的文件页末行尾可能被归一化`;
  }
  const rangeArgv = ['cat', remote, `--start=${startLine}`, `--end=${startLine + maxLines}`, `--max-output=${catCap}`];
  const exactArgv = ['cat', remote, `--start=${startLine}`, `--end=${startLine + maxLines}`, '--exact'];
  let r = await runCli(bin, useExact ? exactArgv : rangeArgv, env, catCap);
  if (r.exitCode !== 0 && useExact) {
    // exact 在超大响应上会被上游截断，自动回退区间模式而不是直接失败
    useExact = false;
    exactNote = `exact 读取失败（${failDetail(r)}），已回退区间模式`;
    r = await runCli(bin, rangeArgv, env, catCap);
  }
  if (r.exitCode !== 0) throw new Error(`读取失败：${withHint(failDetail(r))}`);

  // 撞超长单行：给出该行的字节偏移，允许 allowPartial 就地续读，而不是整个重来
  const partialOf = async (buf) => {
    const offset = await lineByteOffset(bin, env, remote, startLine);
    let cut = Math.min(maxBytes, buf.length);
    if (cut < buf.length) {
      while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut -= 1;
      if (cut === 0) cut = Math.min(maxBytes, buf.length);
    }
    const content = buf.subarray(0, cut).toString('utf8');
    const nextByteStart = (offset === null ? null : offset + cut);
    if (p.allowPartial) {
      return {
        path: remote,
        mode: 'byte',
        startLine,
        maxBytes,
        bytes: cut,
        content,
        nextByteStart,
        totalBytes: meta.totalBytes,
        totalLines: meta.totalLines,
        allowPartial: true,
        hasMore: nextByteStart === null ? true : nextByteStart < meta.totalBytes
      };
    }
    throw new Error(
      `第 ${startLine + 1} 行本身超过 maxBytes=${maxBytes} 字节，行模式取不全：` +
      `改用字节模式 aiod_read_file {path:"${remote}", startByte:${offset === null ? 0 : offset}, maxBytes:200000}` +
      ` 续读（或传 allowPartial:true 让它直接返回该行前缀 + nextByteStart）`
    );
  };

  if (r.stdoutTruncated) {
    if (!r.stdout.includes(NL)) return partialOf(r.stdoutBuffer);
    throw new Error(
      `本次 cat 输出超过采集上限 ${catCap} 字节：请调小 maxLines / maxBytes 后重试（当前 startLine=${startLine}, maxLines=${maxLines}）`
    );
  }

  let content = r.stdout;
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    const buf = Buffer.from(content, 'utf8').subarray(0, maxBytes);
    const cut = buf.lastIndexOf(0x0a);
    if (cut < 0) return partialOf(Buffer.from(content, 'utf8').subarray(0, maxBytes));
    content = buf.subarray(0, cut + 1).toString('utf8');
  }

  let lines = countLines(content);
  let nextStartLine = startLine + lines;
  let hasMore = nextStartLine < meta.totalLines;
  // 区间模式会吃掉区间末行的行尾；--exact 已经逐字节精确，不需要补
  if (!useExact && !content.endsWith(NL) && (hasMore || meta.endsWithNewline)) {
    content += meta.crlf ? '\r\n' : NL;
  }
  lines = countLines(content);
  nextStartLine = startLine + lines;
  hasMore = nextStartLine < meta.totalLines;

  return {
    path: remote,
    mode: 'line',
    startLine,
    maxLines,
    maxBytes,
    lines,
    bytes: Buffer.byteLength(content, 'utf8'),
    content,
    nextStartLine,
    totalLines: meta.totalLines,
    totalBytes: meta.totalBytes,
    crlf: meta.crlf,
    crlfLines: meta.crlfLines,
    exact: useExact,
    ...(exactNote ? { warning: exactNote } : {}),
    hasMore
  };
}

// 上游 edit 会把整份文件用 cat -n 回显；大文件既撑爆上下文，也可能在回显时 ReadFailed
const EDIT_STDOUT_LIMIT = 1500;

function trimStdout(text) {
  const t = (text || '').trim();
  if (t.length <= EDIT_STDOUT_LIMIT) return t;
  return `${t.slice(0, EDIT_STDOUT_LIMIT)}\n...[上游回显已截断，完整内容请用 aiod_read_file 读]`;
}

async function handleEditFile(bin, env, p) {
  const remote = requireAbs(p.path, 'path');
  const mode = String(p.mode || 'first');
  if (!['all', 'first', 'last'].includes(mode)) throw new Error('mode 只能是 all / first / last');

  if (p.insertLine !== undefined && p.insertLine !== null) {
    if (typeof p.old === 'string' || typeof p.new === 'string') {
      throw new Error('插入模式与替换模式不能同时传：请要么传 insertLine+text，要么传 old+new');
    }
    const insertLine = toInt(p.insertLine, -1);
    if (insertLine < 0) throw new Error(`insertLine 必须 ≥ 0（0 表示插在第 1 行之前），当前值：${p.insertLine}`);
    if (typeof p.text !== 'string') throw new Error('插入模式必须提供 text 字符串');
    const meta = await fileMeta(bin, env, remote);
    if (!meta) throw new Error(`插入失败：读不到 ${remote}（路径不存在或不是文件）`);
    if (insertLine > meta.totalLines) {
      throw new Error(`insertLine 超出范围：合法区间 [0, ${meta.totalLines}]（当前文件 ${meta.totalLines} 行），当前值：${insertLine}`);
    }
    const r = await runCli(bin, ['edit', remote, `--insert=${insertLine}`, `--text=${p.text}`], env);
    if (r.exitCode !== 0) throw new Error(`插入失败：${withHint(failDetail(r))}`);
    invalidateMeta(remote);
    return { path: remote, op: 'insert', insertLine, exitCode: r.exitCode, applied: true, stdout: trimStdout(r.stdout), stdoutBytes: r.stdoutBytes };
  }

  if (typeof p.old !== 'string' || p.old === '') {
    throw new Error('old 必填：要替换的原字符串（插入模式请改传 insertLine 与 text）');
  }
  if (p.new === undefined) {
    throw new Error('new 必填：要删除这段文本请显式传 new:"";不传 new 不再默认删除');
  }
  if (typeof p.new !== 'string') throw new Error('new 必须是字符串');

  // 单行 old 可以先数一下命中处数，让 mode=first 不再靠腼
  const singleLine = !p.old.includes(NL);
  let matched = null;
  if (singleLine) {
    const cnt = await runCli(bin, ['exec', `grep -o -F ${shq(p.old)} ${shq(remote)} | wc -l`], env);
    const n = parseInt(cnt.stdout.trim(), 10);
    if (cnt.exitCode === 0 && Number.isFinite(n)) matched = n;
  }
  if (matched !== null && matched > 1 && mode === 'first' && p.allowPartialMismatch !== true) {
    throw new Error(
      `old 在文件里有 ${matched} 处匹配，mode=first 只会改第一处：` +
      '确认要全改请传 mode:"all"；只改第一处请显式传 allowPartialMismatch:true 或把 old 写成唯一片段'
    );
  }

  const argv = ['edit', remote, `--old=${p.old}`, `--new=${p.new}`, `--replace-${mode}`];
  const before = await remoteSha256(bin, env, remote);
  const r = await runCli(bin, argv, env);

  if (r.exitCode !== 0) {
    // 上游会在「已改完但回显失败」（ReadFailed）时报错，用文件哈希确认到底改没改
    const after = await remoteSha256(bin, env, remote);
    const changed = before !== null && after !== null && before !== after;
    if (!changed) throw new Error(`替换失败（mode=${mode}）：${withHint(failDetail(r))}`);
    invalidateMeta(remote);
    return {
      path: remote,
      op: 'replace',
      mode,
      matched,
      exitCode: r.exitCode,
      applied: true,
      note: '上游在回显编辑结果时报错，但文件哈希已变化，说明替换已生效；先用 aiod_read_file 核对，不要重试',
      stdout: trimStdout(r.stdout),
      stdoutBytes: r.stdoutBytes
    };
  }

  invalidateMeta(remote);
  return {
    path: remote,
    op: 'replace',
    mode,
    matched,
    exitCode: r.exitCode,
    applied: true,
    hint: mode === 'first' && matched === null ? 'old 包含多行，本次只替换了第一处；确认无其他匹配点，否则改用 mode:"all"' : undefined,
    stdout: trimStdout(r.stdout),
    stdoutBytes: r.stdoutBytes
  };
}

async function handleWriteStream(bin, env, p) {
  const now = Date.now();
  for (const [id, rec] of uploads) {
    if (now - rec.at > UPLOAD_TTL_MS) {
      fs.rmSync(rec.dir, { recursive: true, force: true });
      uploads.delete(id);
    }
  }

  if (p.begin) {
    const target = requireAbs(p.path, 'path');
    const content = typeof p.content === 'string' ? p.content : '';
    const beginBytes = Buffer.byteLength(content, 'utf8');
    if (beginBytes > MAX_CONTENT) {
      throw new Error(`单段 content ${beginBytes} 字节超过上限 ${MAX_CONTENT}：请拆成更多段（每段 ≤200000 字节）`);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiod-stream-'));
    const file = path.join(dir, 'data.bin');
    fs.writeFileSync(file, Buffer.from(content, 'utf8'));
    const uploadId = `up_${now}_${Math.random().toString(36).slice(2, 7)}`;
    uploads.set(uploadId, { dir, file, target, bytes: Buffer.byteLength(content, 'utf8'), chunks: 1, at: now });
    return { uploadId, path: target, bytes: Buffer.byteLength(content, 'utf8'), chunks: 1, done: false };
  }

  const uploadId = String(p.uploadId || '');
  const rec = uploads.get(uploadId);
  if (!rec) throw new Error(`uploadId 不存在或已结束：${uploadId}（请用 begin:true 重新开始）`);

  const content = typeof p.content === 'string' ? p.content : '';
  const chunkBytes = Buffer.byteLength(content, 'utf8');
  if (chunkBytes > MAX_CONTENT) {
    throw new Error(`单段 content ${chunkBytes} 字节超过上限 ${MAX_CONTENT}：请拆成更多段（每段 ≤200000 字节）`);
  }
  if (content) {
    fs.appendFileSync(rec.file, Buffer.from(content, 'utf8'));
    rec.bytes += Buffer.byteLength(content, 'utf8');
    rec.chunks += 1;
    rec.at = Date.now();
  }
  if (rec.bytes > MAX_UPLOAD_BYTES) {
    fs.rmSync(rec.dir, { recursive: true, force: true });
    uploads.delete(uploadId);
    throw new Error(`流式写赛累计 ${rec.bytes} 字节，超过上限 ${MAX_UPLOAD_BYTES}：请拆成多个文件`);
  }
  if (!p.final) return { uploadId, path: rec.target, bytes: rec.bytes, chunks: rec.chunks, done: false };

  try {
    const localHash = hashBuf(fs.readFileSync(rec.file));
    const r = await runCli(bin, ['put', rec.file, rec.target, '--overwrite'], env);
    if (r.exitCode !== 0) throw new Error(`写入失败：${withHint(failDetail(r))}`);
    invalidateMeta(rec.target);
    const actual = await remoteSize(bin, env, rec.target);
    if (actual !== rec.bytes) {
      throw new Error(`写入校验失败：本地 ${rec.bytes} 字节，沙箱 ${actual === null ? '读不到文件' : actual + ' 字节'}`);
    }
    const remoteHash = await remoteSha256(bin, env, rec.target);
    return {
      uploadId,
      path: rec.target,
      bytes: rec.bytes,
      chunks: rec.chunks,
      done: true,
      sha256: localHash,
      remoteSha256: remoteHash,
      sha256Match: remoteHash === null ? null : remoteHash === localHash,
      verified: remoteHash !== null && remoteHash === localHash
    };
  } finally {
    fs.rmSync(rec.dir, { recursive: true, force: true });
    uploads.delete(uploadId);
  }
}

async function handleStat(bin, env, p) {
  const remote = requireAbs(p.path, 'path');
  const isDir = await runCli(bin, ['exec', `test -d ${shq(remote)}`], env);
  if (isDir.exitCode === 0) {
    return { path: remote, exists: true, isDirectory: true, bytes: null, lines: null, endsWithNewline: null, crlf: null, sha256: null };
  }
  const meta = await fileMeta(bin, env, remote);
  if (!meta) return { path: remote, exists: false };
  return {
    path: remote,
    exists: true,
    isDirectory: false,
    bytes: meta.totalBytes,
    lines: meta.totalLines,
    endsWithNewline: meta.endsWithNewline,
    crlf: meta.crlf,
    sha256: await remoteSha256(bin, env, remote)
  };
}

async function handleTransfer(bin, env, p) {
  const local = String(p.localPath || '');
  const remote = requireAbs(p.remotePath, 'remotePath');
  if (!local) throw new Error('localPath 必填：本机绝对路径，例如 D:/work/app.py（Windows 上没有 /tmp）');
  if (p.direction !== 'get' && p.direction !== 'put') {
    throw new Error(`direction 只能是 "get"（沙箱→本机）或 "put"（本机→沙箱），当前值：${p.direction}`);
  }

  if (p.direction === 'get') {
    const known = await remoteSize(bin, env, remote);
    if (known === null) throw new Error(`下载失败：沙箱里读不到 ${remote}`);
    // 上游 get 不会覆盖本机已有文件（报的是 FileNotFound 这种误导性错误），先删
    if (fs.existsSync(local)) {
      try { fs.rmSync(local); } catch (_) {}
    }
    const r = await runCli(bin, ['get', remote, local], env);
    if (r.exitCode !== 0) throw new Error(`下载失败：${withHint(failDetail(r))}`);
    const buf = fs.existsSync(local) ? fs.readFileSync(local) : null;
    const localHash = buf ? hashBuf(buf) : null;
    const remoteHash = await remoteSha256(bin, env, remote);
    return {
      direction: 'get',
      remotePath: remote,
      localPath: local,
      bytes: buf ? buf.length : null,
      remoteBytes: known,
      sha256: localHash,
      remoteSha256: remoteHash,
      sha256Match: localHash && remoteHash ? localHash === remoteHash : null,
      verified: buf !== null && (localHash && remoteHash ? localHash === remoteHash : buf.length === known),
      stdout: r.stdout.trim()
    };
  }

  if (!fs.existsSync(local)) {
    throw new Error(`本地文件不存在：${local}。这是本机路径（Windows 上用 D:/work/app.py 这种写法，不要用 /tmp）；先确认文件已落盘再上传`);
  }
  const buf = fs.readFileSync(local);
  const overwrite = p.overwrite !== false;
  const argv = ['put', local, remote];
  if (overwrite) argv.push('--overwrite');
  const r = await runCli(bin, argv, env);
  if (r.exitCode !== 0) throw new Error(`上传失败：${withHint(failDetail(r))}`);
  invalidateMeta(remote);
  const actual = await remoteSize(bin, env, remote);
  if (actual !== buf.length) {
    throw new Error(`上传校验失败：本地 ${buf.length} 字节，沙箱 ${actual === null ? '读不到文件' : actual + ' 字节'}`);
  }
  const localHash = hashBuf(buf);
  const remoteHash = await remoteSha256(bin, env, remote);
  return {
    direction: 'put',
    localPath: local,
    remotePath: remote,
    bytes: buf.length,
    remoteBytes: actual,
    sha256: localHash,
    remoteSha256: remoteHash,
    sha256Match: remoteHash === null ? null : remoteHash === localHash,
    verified: remoteHash !== null && remoteHash === localHash,
    stdout: r.stdout.trim()
  };
}

// 上游 CLI 的 --max-output 默认只有 ~50KB 且会「保留头尾、丢掉中段」，必须显式顶到我们要的上限
function withMaxOutput(argv, cap) {
  if (argv.some((a) => String(a).startsWith('--max-output'))) return argv;
  return [...argv, `--max-output=${cap}`];
}

async function handleExec(bin, env, p) {
  const command = String(p.command || '');
  if (!command.trim()) throw new Error('command 必填：要在沙箱内执行的命令（整条字符串，不需要自己转义引号）');
  if (command.includes('\u0000')) throw new Error('command 不能包含 NUL 字符');
  const cap = clamp(toInt(p.maxOutputBytes, MAX_OUTPUT), 4096, MAX_OUTPUT_CAP);
  const flags = [];
  if (p.cwd) flags.push(`--cwd=${p.cwd}`);
  if (p.shell) flags.push(`--shell=${p.shell}`);
  if (p.timeoutSec) flags.push(`--hard-timeout=${toInt(p.timeoutSec, 0)}`);
  if (p.commandEnv && typeof p.commandEnv === 'object') {
    const pairs = Object.entries(p.commandEnv).map(([k, v]) => `${k}=${v}`);
    if (pairs.length) flags.push(`--env=${pairs.join(',')}`);
  }
  flags.push(`--max-output=${cap}`);
  invalidateMeta();

  // 随包二进制已把子进程 stderr 原样写到 CLI 的 stderr（两路真分离）；
  // separateStderr 退化为兼容参数：传入不报错，但不再额外包一层临时文件（那会更慢且丢 cwd 错误）
  const r = await runCli(bin, ['exec', command, ...flags], env, cap);
  return {
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exitCode,
    stdoutBytes: r.stdoutBytes,
    stderrBytes: r.stderrBytes,
    stderrMerged: false,
    // 上游截断会在 stderr 打一行 machine-readable warning
    stdoutTruncated: r.stdoutTruncated || hasTruncationMarker(r.stdout) || /aiod-cli: warning: output truncated/.test(r.stderr),
    stderrTruncated: r.stderrTruncated
  };
}

// 真正的沙箱侧异步任务：aiod-cli async 拿 command_id，输出留在沙箱服务端，
// 任务映射写到本机临时文件，Node worker 被回收后还能继续用 commandId 读/杀。
const TASK_STORE = path.join(os.tmpdir(), 'aiod-cli-tasks.json');
const TASK_TTL_MS = 24 * 60 * 60 * 1000;

function baseKey(env) {
  return crypto.createHash('sha1').update(String(env.SANDBOX_BASE || '')).digest('hex').slice(0, 12);
}

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(TASK_STORE, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function saveStore(store) {
  const now = Date.now();
  for (const [k, v] of Object.entries(store)) {
    if (!v || now - (v.updatedAt || v.createdAt || 0) > TASK_TTL_MS) delete store[k];
  }
  try {
    fs.writeFileSync(TASK_STORE, JSON.stringify(store));
  } catch (err) {
    log(`task store write failed: ${err.message}`);
  }
}

async function handleSubmit(bin, env, p) {
  const command = String(p.command || (Array.isArray(p.args) && p.args.length ? p.args[0] : ''));
  if (!command.trim()) throw new Error('command 必填：要在沙箱后台执行的命令字符串');
  if (command.includes('\u0000')) throw new Error('command 不能包含 NUL 字符');
  const argv = ['async', command];
  if (p.cwd) argv.push(`--cwd=${p.cwd}`);
  if (p.shell) argv.push(`--shell=${p.shell}`);
  if (p.timeoutSec) argv.push(`--hard-timeout=${toInt(p.timeoutSec, 0)}`);
  if (p.commandEnv && typeof p.commandEnv === 'object') {
    const pairs = Object.entries(p.commandEnv).map(([k, v]) => `${k}=${v}`);
    if (pairs.length) argv.push(`--env=${pairs.join(',')}`);
  }
  invalidateMeta();
  const r = await runCli(bin, argv, env);
  if (r.exitCode !== 0) throw new Error(`提交失败：${withHint(failDetail(r))}`);
  const commandId = r.stdout.trim().split(/\s+/)[0];
  if (!/^[0-9a-zA-Z_-]{8,}$/.test(commandId)) {
    throw new Error(`提交失败：没拿到 command_id（上游输出：${r.stdout.trim().slice(0, 120)}）`);
  }
  const store = loadStore();
  store[`${baseKey(env)}:${commandId}`] = {
    command, cwd: p.cwd || null, createdAt: Date.now(), updatedAt: Date.now(),
    outOffset: 0, errOffset: 0, status: 'running'
  };
  saveStore(store);
  return {
    taskId: commandId,
    commandId,
    status: 'running',
    sandbox: true,
    message: `已在沙箱后台启动（command_id=${commandId}）；用 aiod_log 读输出，用 aiod_kill 真正终止`
  };
}

async function handleLog(bin, env, p) {
  const commandId = String(p.taskId || p.commandId || '');
  if (!commandId) throw new Error('taskId 必填：aiod_submit 返回的 commandId');
  const key = `${baseKey(env)}:${commandId}`;
  const store = loadStore();
  const rec = store[key] || { outOffset: 0, errOffset: 0 };
  const tail = Math.max(0, toInt(p.tail, 0));
  const outOffset = tail > 0 ? 0 : (p.offset !== undefined ? Math.max(0, toInt(p.offset, 0)) : rec.outOffset || 0);
  const errOffset = tail > 0 ? 0 : rec.errOffset || 0;

  // 上游的 wait=true 在当前服务端版本里不生效，插件自己做有界轮询
  const terminal = (st) => ['completed', 'failed', 'killed', 'exited', 'timed_out'].includes(st);
  const waitMs = p.wait ? clamp(toInt(p.waitTimeoutSec, 10), 1, 120) * 1000 : 0;
  const deadline = Date.now() + waitMs;
  let body = null;
  let d = {};
  let r = { stdoutTruncated: false };
  for (;;) {
    const argv = ['exec', `--id=${commandId}`, '--json', `--offset=${outOffset}`, `--stderr-offset=${errOffset}`];
    r = await runCli(bin, argv, env);
    if (r.exitCode !== 0) throw new Error(`读取失败：${withHint(failDetail(r))}`);
    try {
      body = JSON.parse(r.stdout);
    } catch (_) {
      throw new Error(`上游返回不是 JSON（可能 command_id 不存在）：${r.stdout.trim().slice(0, 160)}`);
    }
    d = body.data || {};
    const gotStdout = typeof d.stdout === 'string' && d.stdout.length > 0;
    const gotStderr = typeof d.stderr === 'string' && d.stderr.length > 0;
    const st = (d.command && d.command.status) || d.status || '';
    if (!waitMs || gotStdout || gotStderr || terminal(st) || Date.now() >= deadline) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  const cmd = d.command || {};
  const stdout = typeof d.stdout === 'string' ? d.stdout : '';
  const stderr = typeof d.stderr === 'string' ? d.stderr : '';
  const nextOffset = Number.isFinite(d.offset) ? d.offset : outOffset + Buffer.byteLength(stdout, 'utf8');
  const nextErrOffset = Number.isFinite(d.stderr_offset) ? d.stderr_offset : errOffset + Buffer.byteLength(stderr, 'utf8');
  const status = typeof cmd.status === 'string' ? cmd.status : (typeof d.status === 'string' ? d.status : 'unknown');
  const rawExit = Number.isFinite(cmd.exit_code) ? cmd.exit_code : d.exit_code;
  const exitCode = Number.isFinite(rawExit) ? rawExit : null;
  const gap = d.stdout_gap === true || d.stderr_gap === true;

  store[key] = {
    ...(store[key] || { commandId }),
    commandId, status, exitCode, outOffset: nextOffset, errOffset: nextErrOffset, updatedAt: Date.now()
  };
  saveStore(store);

  const merged = stderr ? (stdout && !stdout.endsWith(NL) ? `${stdout}${NL}${stderr}` : stdout + stderr) : stdout;
  const rows = merged.split(NL);
  if (rows.length && rows[rows.length - 1] === '') rows.pop();
  const logs = tail > 0 ? rows.slice(-tail) : rows;
  return {
    taskId: commandId,
    commandId,
    status,
    completed: ['completed', 'failed', 'killed', 'exited', 'timed_out'].includes(status),
    exitCode,
    logs,
    nextOffset,
    nextErrOffset,
    totalLines: rows.length,
    droppedLines: 0,
    gap,
    truncated: !!r.stdoutTruncated
  };
}

async function handleKill(bin, env, p) {
  const commandId = String(p.taskId || p.commandId || '');
  if (!commandId) throw new Error('taskId 必填：要终止的 commandId');
  const r = await runCli(bin, ['kill', commandId], env);
  if (r.exitCode !== 0) throw new Error(`终止失败：${withHint(failDetail(r))}`);
  const store = loadStore();
  const key = `${baseKey(env)}:${commandId}`;
  if (store[key]) {
    store[key].status = 'killed';
    store[key].updatedAt = Date.now();
    saveStore(store);
  }
  return { taskId: commandId, commandId, killed: true, stdout: r.stdout.trim() };
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line || !line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch (err) {
    return;
  }

  const { id, method, params = {} } = request;
  const bin = findBinary();
  const env = buildEnv(request);

  // 网关校验：上游对着一个空/畸形 SANDBOX_BASE 只会回 error: InvalidFormat，
  // Agent 根本无从自查，所以在插件层先拦住并说清怎么做
  if (method !== 'aiod/version') {
    const base = String(env.SANDBOX_BASE || '').trim();
    if (!/^https?:\/\/[^\s]+$/i.test(base)) {
      reply(id, null, {
        code: -32011,
        message:
          `沙箱网关无效（SANDBOX_BASE=${base ? base.slice(0, 80) : '空'}）：` +
          '请在每次调用里传 base 参数（cube-cli new 打印的 AIO 网关地址），或到插件设置页填写 SANDBOX_BASE'
      });
      return;
    }
  }

  const run = async () => {
    switch (method) {
      case 'aiod/run': {
        const cmd = params.cmd || 'version';
        const cap = clamp(toInt(params.maxOutput, MAX_OUTPUT), 4096, MAX_OUTPUT_CAP);
        let argv = [cmd, ...(Array.isArray(params.args) ? params.args : [])];
        if (cmd === 'exec' || cmd === 'async') argv = withMaxOutput(argv, cap);
        invalidateMeta();
        const r = await runCli(bin, argv, env, cap);
        return {
          stdout: r.stdout,
          stderr: r.stderr,
          exitCode: r.exitCode,
          stdoutBytes: r.stdoutBytes,
          stderrBytes: r.stderrBytes,
          stdoutTruncated: r.stdoutTruncated || hasTruncationMarker(r.stdout),
          stderrTruncated: r.stderrTruncated
        };
      }
      case 'aiod/health': {
        const r = await runCli(bin, ['health'], env);
        return { stdout: r.stdout.trimEnd(), stderr: r.stderr.trimEnd(), exitCode: r.exitCode };
      }
      case 'aiod/write-file':
        return handleWriteFile(bin, env, params);
      case 'aiod/write-stream':
        return handleWriteStream(bin, env, params);
      case 'aiod/stat':
        return handleStat(bin, env, params);
      case 'aiod/read-file':
        return handleReadFile(bin, env, params);
      case 'aiod/edit-file':
        return handleEditFile(bin, env, params);
      case 'aiod/transfer':
        return handleTransfer(bin, env, params);
      case 'aiod/exec':
        return handleExec(bin, env, params);
      case 'aiod/submit':
        return handleSubmit(bin, env, params);
      case 'aiod/log':
        return handleLog(bin, env, params);
      case 'aiod/kill':
        return handleKill(bin, env, params);
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { rpcCode: -32601 });
    }
  };

  run().then(
    (result) => reply(id, result),
    (err) => {
      if (err && err.rpcCode) {
        reply(id, null, { code: err.rpcCode, message: err.message });
        return;
      }
      reply(id, null, { code: -32000, message: (err && err.message) || String(err) });
    }
  );
});
