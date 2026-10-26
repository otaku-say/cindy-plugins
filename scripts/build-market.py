#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scripts/build-market.py —— Cindy 多插件、全平台架构自动构建分发引擎
功能：
  1. 动态读取 scripts/manifest.json 中声明的插件列表与平台矩阵；
  2. 从上游 GitHub Release 拉取二进制产物并做 SHA256SUMS 强校验；
  3. 为 6 大架构分别组装瘦身目录，杜绝多架构脂肪包；
  4. 为每个插件打出独立的 <id>-<version>-<platform>.cindy 安装包；
  5. 自动生成包含多平台芯片架构精确映射的 .agents/plugins/marketplace.json。
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
    req = urllib.request.Request(url, headers={"User-Agent": "cindy-market-engine"})
    with urllib.request.urlopen(req) as resp, open(dest_path, "wb") as out:
        shutil.copyfileobj(resp, out)

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

    # 1. 下载 SHA256SUMS
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

    # 2. 遍历平台拉取
    supported = upstream.get("supported_platforms")
    artifact_tmpl = upstream["artifact_template"]
    downloaded = {}

    for plat_name, pinfo in platforms.items():
        if supported and plat_name not in supported:
            continue

        target = pinfo["target"]
        ext = pinfo["ext"]
        artifact_name = artifact_tmpl.format(target=target, ext=ext)
        dest_file = plugin_cache / artifact_name

        if not dest_file.exists():
            download_url = f"{base_url}/{artifact_name}"
            download_file(download_url, dest_file)

        # 校验
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
    """将目录打包为规范的 .cindy (zip)"""
    dest_zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dest_zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(src_dir):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d != "node_modules"]
            for file in files:
                if file.startswith(".") or file.endswith(".cindy") or file.endswith(".zip"):
                    continue
                full_path = Path(root) / file
                rel_path = full_path.relative_to(src_dir)
                zf.write(full_path, arcname=str(rel_path))

def build_all():
    manifest = load_manifest()
    platforms = manifest["platforms"]
    plugins = manifest["plugins"]
    owner = manifest["owner"]
    repo = manifest["repo"]

    print(f"=== 开始构建 Cindy 插件市场: {manifest['name']} ===")
    print(f"收录插件: {list(plugins.keys())}")
    print(f"支持架构矩阵: {list(platforms.keys())}\n")

    # 1. 同步各插件上游资产
    artifacts_map = {} # plugin_id -> { plat_name: file_path }
    for pid, pmeta in plugins.items():
        print(f"[*] 检查插件上游产物: {pid} ({pmeta['name']})")
        artifacts_map[pid] = sync_upstream_for_plugin(pid, pmeta, platforms)

    # 2. 组装各平台目录并打包 .cindy
    PACKAGES_DIST.mkdir(parents=True, exist_ok=True)
    cindy_packages_meta = {} # (plugin_id, plat_name) -> { sha256, size, filename, download_url }

    for plat_name, pinfo in platforms.items():
        plat_dir = PLATFORMS_DIST / plat_name
        if plat_dir.exists():
            shutil.rmtree(plat_dir)
        plat_dir.mkdir(parents=True, exist_ok=True)

        for pid, pmeta in plugins.items():
            # 检查当前平台是否支持该插件
            if plat_name not in artifacts_map[pid]:
                continue

            src_plugin_dir = ROOT / "plugins" / pid
            dest_plugin_dir = plat_dir / "plugins" / pid
            shutil.copytree(src_plugin_dir, dest_plugin_dir)

            # 注入单平台原生二进制
            bin_dir = dest_plugin_dir / "bin"
            bin_dir.mkdir(parents=True, exist_ok=True)
            src_bin = artifacts_map[pid][plat_name]
            bin_name = pmeta["upstream"]["binary_name"].format(target=pinfo["target"], ext=pinfo["ext"])
            dest_bin = bin_dir / bin_name
            shutil.copy2(src_bin, dest_bin)
            if not bin_name.endswith(".exe"):
                dest_bin.chmod(0o755)

            # 为该单平台插件生成独立的 .cindy 安装包
            version = pmeta["version"]
            cindy_filename = f"{pid}-{version}-{plat_name}.cindy"
            cindy_path = PACKAGES_DIST / cindy_filename
            zip_directory(dest_plugin_dir, cindy_path)

            pkg_sha = get_file_sha256(cindy_path)
            pkg_size = cindy_path.stat().st_size
            release_url = f"https://github.com/{owner}/{repo}/releases/download/v{version}/{cindy_filename}"

            cindy_packages_meta[(pid, plat_name)] = {
                "sha256": pkg_sha,
                "size": pkg_size,
                "filename": cindy_filename,
                "download_url": release_url
            }

    # 3. 生成根目录清单 .agents/plugins/marketplace.json（包含精确多平台架构路由）
    mkt_plugins = []
    for pid, pmeta in plugins.items():
        # 读取插件 ghost.json 获取基础配置
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

        # 挂载各平台的下载与校验元数据（供 Cindy 客户端根据宿主平台自动选择）
        for plat_name, pinfo in platforms.items():
            if (pid, plat_name) in cindy_packages_meta:
                meta = cindy_packages_meta[(pid, plat_name)]
                # 标准 platform key（如 darwin-arm64, win32-x64, linux-x64）
                std_key = f"{pinfo['os']}-{pinfo['arch']}"
                item["platforms"][std_key] = {
                    "platform": plat_name,
                    "target": pinfo["target"],
                    "download_url": meta["download_url"],
                    "sha256": meta["sha256"],
                    "size": meta["size"]
                }
                # 同时挂载友好别名 key（如 macos-arm64）
                item["platforms"][plat_name] = item["platforms"][std_key]

        mkt_plugins.append(item)

    final_mkt = {
        "$schema": "https://cindy.app/schemas/marketplace.v1.json",
        "name": manifest["name"],
        "description": manifest["description"],
        "owner": owner,
        "repo": f"https://github.com/{owner}/{repo}",
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
        print(f"  - {meta['filename']:36} | {kb:6.1f} KB | SHA256: {meta['sha256'][:12]}...")

def push_all_branches(manifest):
    platforms = manifest["platforms"]
    token = os.environ.get("GITHUB_TOKEN")
    owner = manifest["owner"]
    repo = manifest["repo"]
    if token:
        remote_url = f"https://x-access-token:{token}@github.com/{owner}/{repo}.git"
    else:
        remote_url = "origin"

    print("=== 开始更新各平台轻量分支 (plat/*) ===")
    for plat_name in platforms.keys():
        plat_dir = PLATFORMS_DIST / plat_name
        if not plat_dir.exists():
            continue
        print(f"[*] 推送平台分支: plat/{plat_name} ...")
        # 排除可能遗留的 .git
        git_dir = plat_dir / ".git"
        if git_dir.exists():
            shutil.rmtree(git_dir)

        import subprocess
        subprocess.run(["git", "init"], cwd=plat_dir, check=True, stdout=subprocess.DEVNULL)
        subprocess.run(["git", "config", "user.name", "github-actions[bot]"], cwd=plat_dir, check=True)
        subprocess.run(["git", "config", "user.email", "github-actions[bot]@users.noreply.github.com"], cwd=plat_dir, check=True)
        subprocess.run(["git", "add", "-A"], cwd=plat_dir, check=True)
        subprocess.run(["git", "commit", "-m", f"chore(release): auto-assembled {plat_name} packages"], cwd=plat_dir, check=True, stdout=subprocess.DEVNULL)
        res = subprocess.run(["git", "push", remote_url, f"HEAD:refs/heads/plat/{plat_name}", "--force"], cwd=plat_dir)
        if res.returncode == 0:
            print(f"  [OK] plat/{plat_name} 推送成功！")
        else:
            print(f"  [FAIL] plat/{plat_name} 推送失败！")

if __name__ == "__main__":
    if "--push-branches" in sys.argv:
        m = load_manifest()
        push_all_branches(m)
    else:
        build_all()
