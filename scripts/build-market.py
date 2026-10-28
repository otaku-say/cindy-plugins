#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scripts/build-market.py —— Cindy 多插件、全平台架构自动构建分发引擎
严格遵循系统全称 (macos, windows, linux) 与芯片架构全称 (arm64, amd64) 规范：
  macos-arm64, macos-amd64, windows-amd64, windows-arm64, linux-amd64, linux-arm64
"""

import os
import sys
import json
import shutil
import zipfile
import urllib.request
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / "scripts" / "manifest.json"
CACHE_DIR = ROOT / ".cache" / "upstream"
DIST_DIR = ROOT / "dist"
PLATFORMS_DIST = DIST_DIR / "platforms"
PACKAGES_DIST = DIST_DIR / "packages"

def load_manifest():
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def download_file(url, dest_path):
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"  [HTTP] 下载: {url} -> {dest_path.name}")
    headers = {"User-Agent": "cindy-market-engine"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req) as resp, open(dest_path, "wb") as out:
            shutil.copyfileobj(resp, out)
    except Exception as e:
        print(f"  [FALLBACK] urllib 失败 ({e})，切换 curl 下载...")
        import subprocess
        curl_cmd = ["curl", "-fsSL", url, "-o", str(dest_path)]
        if token:
            curl_cmd[2:2] = ["-H", f"Authorization: Bearer {token}"]
        subprocess.run(curl_cmd, check=True)

def get_file_sha256(file_path):
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()

def sync_upstream_for_plugin(plugin_id, plugin_meta, platforms):
    upstream = plugin_meta.get("upstream")
    if not upstream:
        return {}

    repo = upstream["repo"]
    tag = upstream["tag"]
    base_url = f"https://github.com/{repo}/releases/download/{tag}"
    plugin_cache = CACHE_DIR / plugin_id
    plugin_cache.mkdir(parents=True, exist_ok=True)

    sums_file = plugin_cache / "SHA256SUMS"
    try:
        download_file(f"{base_url}/SHA256SUMS", sums_file)
    except Exception as e:
        print(f"  [WARN] 无法获取 SHA256SUMS: {e}")

    checksums = {}
    if sums_file.exists():
        with open(sums_file, "r", encoding="utf-8") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 2:
                    checksums[parts[1]] = parts[0]

    supported = upstream.get("supported_platforms")
    artifact_tmpl = upstream["artifact_template"]
    downloaded = {}

    for plat_name, pinfo in platforms.items():
        if supported and plat_name not in supported:
            continue

        target = pinfo["target"]
        ext = pinfo["ext"]
        artifact_name = artifact_tmpl.format(target=target, os=pinfo["os"], arch=pinfo["arch"], ext=ext)
        dest_file = plugin_cache / artifact_name

        if not dest_file.exists():
            download_url = f"{base_url}/{artifact_name}"
            download_file(download_url, dest_file)

        actual_sha = get_file_sha256(dest_file)
        if artifact_name in checksums:
            expected_sha = checksums[artifact_name]
            if actual_sha != expected_sha:
                raise ValueError(f"校验失败: {artifact_name} (期望: {expected_sha}, 实际: {actual_sha})")
            print(f"  [SHA256] 校验通过: {artifact_name}")
        else:
            print(f"  [SHA256] 记录指纹: {artifact_name} ({actual_sha[:12]})")

        downloaded[plat_name] = dest_file

    return downloaded

def zip_directory(src_dir, dest_zip_path):
    dest_zip_path.parent.mkdir(parents=True, exist_ok=True)

    # 先显式收集并排序：os.walk 的遍历顺序取决于具体文件系统，不同环境打出的条目
    # 顺序不同，会把同样的内容压成不同的字节流 —— 这样市场清单里的 SHA256 与线上
    # Release 资产永远对不上。排序后本地产物与 CI 产物逐字节一致。
    entries = []
    for root, dirs, files in os.walk(src_dir):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d != "node_modules")
        for file in sorted(files):
            if file.startswith(".") or file.endswith(".cindy") or file.endswith(".zip"):
                continue
            full_path = Path(root) / file
            entries.append((full_path.relative_to(src_dir).as_posix(), full_path))
    entries.sort(key=lambda item: item[0])

    with zipfile.ZipFile(dest_zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel_str, full_path in entries:
            # 固定时间戳 + 固定权限：同样的内容必须打出同样的 SHA256，
            # 否则每次 CI 都会因包体哈希变化而重写 marketplace.json，产生无意义的脏 diff。
            info = zipfile.ZipInfo(rel_str, date_time=(1980, 1, 1, 0, 0, 0))
            info.external_attr = (0o755 if os.access(full_path, os.X_OK) else 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(full_path, "rb") as fh:
                zf.writestr(info, fh.read())

def build_all():
    manifest = load_manifest()
    platforms = manifest["platforms"]
    plugins = manifest["plugins"]
    owner = manifest["owner"]
    # CI 把所有插件的包统一发到 v<全部插件版本的最大值> 这个 Release（见
    # .github/workflows/build-market.yml），所以下载地址必须用同一个 tag，
    # 否则非最高版本的插件会指向一个根本不存在的 Release。
    release_tag = "v" + max(pl["version"] for pl in plugins.values())
    repo = manifest["repo"]

    print(f"=== 开始构建 Cindy 插件市场: {manifest['name']} ===")
    print(f"收录插件: {list(plugins.keys())}")
    print(f"支持架构矩阵: {list(platforms.keys())}\n")

    artifacts_map = {}
    for pid, pmeta in plugins.items():
        print(f"[*] 检查插件上游产物: {pid} ({pmeta['name']})")
        artifacts_map[pid] = sync_upstream_for_plugin(pid, pmeta, platforms)

    PACKAGES_DIST.mkdir(parents=True, exist_ok=True)
    cindy_packages_meta = {}

    for plat_name, pinfo in platforms.items():
        plat_dir = PLATFORMS_DIST / plat_name
        if plat_dir.exists():
            shutil.rmtree(plat_dir)
        plat_dir.mkdir(parents=True, exist_ok=True)

        for pid, pmeta in plugins.items():
            has_upstream = bool(pmeta.get("upstream"))
            if has_upstream and plat_name not in artifacts_map[pid]:
                continue

            src_plugin_dir = ROOT / "plugins" / pid
            dest_plugin_dir = plat_dir / "plugins" / pid
            shutil.copytree(src_plugin_dir, dest_plugin_dir)

            if has_upstream:
                bin_dir = dest_plugin_dir / "bin"
                if bin_dir.exists():
                    shutil.rmtree(bin_dir)
                bin_dir.mkdir(parents=True, exist_ok=True)

                src_bin = artifacts_map[pid][plat_name]
                bin_name = pmeta["upstream"]["binary_name"].format(target=pinfo["target"], ext=pinfo["ext"])
                dest_bin = bin_dir / bin_name
                shutil.copy2(src_bin, dest_bin)
                if not bin_name.endswith(".exe"):
                    dest_bin.chmod(0o755)

            version = pmeta["version"]
            cindy_filename = f"{pid}-{version}-{plat_name}.cindy"
            cindy_path = PACKAGES_DIST / cindy_filename
            zip_directory(dest_plugin_dir, cindy_path)

            pkg_sha = get_file_sha256(cindy_path)
            pkg_size = cindy_path.stat().st_size
            release_url = f"https://github.com/{owner}/{repo}/releases/download/{release_tag}/{cindy_filename}"

            cindy_packages_meta[(pid, plat_name)] = {
                "sha256": pkg_sha,
                "size": pkg_size,
                "filename": cindy_filename,
                "download_url": release_url
            }

    # 生成全局市场清单
    mkt_plugins = []
    for pid, pmeta in plugins.items():
        ghost_path = ROOT / "plugins" / pid / "ghost.json"
        ghost_data = {}
        if ghost_path.exists():
            with open(ghost_path, "r", encoding="utf-8") as f:
                ghost_data = json.load(f)

        item = {
            "id": pid,
            "name": pmeta["name"],
            "description": pmeta["description"],
            "version": pmeta["version"],
            "command": pmeta.get("command", ghost_data.get("command")),
            "author": pmeta.get("author", "Cindy Community"),
            "source": f"plugins/{pid}",
            "icon": f"plugins/{pid}/assets/icon.png",
            "whenToUse": ghost_data.get("whenToUse", ""),
            "tags": pmeta.get("tags", []),
            "platforms": {}
        }

        for plat_name, pinfo in platforms.items():
            if (pid, plat_name) in cindy_packages_meta:
                meta = cindy_packages_meta[(pid, plat_name)]
                # 标准规范键：<os>-<arch> (例如 macos-arm64, macos-amd64, windows-amd64, linux-amd64 等)
                item["platforms"][plat_name] = {
                    "platform": plat_name,
                    "os": pinfo["os"],
                    "arch": pinfo["arch"],
                    "target": pinfo["target"],
                    "download_url": meta["download_url"],
                    "sha256": meta["sha256"],
                    "size": meta["size"]
                }

        mkt_plugins.append(item)

    final_mkt = {
        "$schema": "https://cindy.app/schemas/marketplace.v1.json",
        "name": manifest["name"],
        "description": manifest["description"],
        "owner": owner,
        "repo": f"https://github.com/{owner}/{repo}",
        "platforms": manifest["platforms"],
        "plugins": mkt_plugins
    }

    mkt_out = ROOT / ".agents" / "plugins" / "marketplace.json"
    mkt_out.parent.mkdir(parents=True, exist_ok=True)
    with open(mkt_out, "w", encoding="utf-8") as f:
        json.dump(final_mkt, f, ensure_ascii=False, indent=2)

    print("\n[+] 市场清单已生成: .agents/plugins/marketplace.json")
    print(f"[+] 各平台 .cindy 安装包已生成 (共 {len(cindy_packages_meta)} 项):\n")
    for (pid, plat_name), meta in cindy_packages_meta.items():
        kb = meta["size"] / 1024
        print(f"  - {meta['filename']:40} | {kb:6.1f} KB | SHA256: {meta['sha256'][:12]}...")

if __name__ == "__main__":
    import traceback
    try:
        if "--fetch" in sys.argv:
            # 只把上游发布资产拉到 .cache/upstream（供 embed-binaries.py 内嵌进 main）
            m = load_manifest()
            for pid, pmeta in m["plugins"].items():
                if pmeta.get("upstream"):
                    sync_upstream_for_plugin(pid, pmeta, m["platforms"])
        else:
            build_all()
    except Exception as e:
        print(f"\n[CRITICAL ERROR] 执行失败: {e}", file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
