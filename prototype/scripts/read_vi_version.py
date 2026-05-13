#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
read_vi_version.py
==================

从 LabVIEW VI 文件头读取保存版本号。

不依赖 LabVIEW 安装，不需要 COM / ActiveX，纯文件解析，跨平台可用。

原理
----
LabVIEW VI 文件（.vi / .ctl / .vit 等）是 LabVIEW 私有的 RSRC 格式：
- 文件以魔数 b"RSRC" 开头。
- 文件头前 512 字节内存在版本标记 00 00 00 A0，
  紧随其后的两个字节以 BCD（Binary-Coded Decimal）编码保存主版本和次版本：
    字节 +4：主版本 BCD，例如 0x17 → 23（十进制）→ LabVIEW 2017？
    实际规则：高4位×10 + 低4位 = 十进制值，LV 主版本对应年份后两位（17→2017）。
    字节 +5：次版本 BCD，例如 0x00 → 0，0x03 → 3。

输出格式
--------
  <major>.<minor>
  例如：17.0  →  LabVIEW 2017 (SP0)
       20.0  →  LabVIEW 2020 (SP0)
       25.3  →  LabVIEW 2025 SP3
       14.0  →  LabVIEW 2014 (SP0)

可选的 --year 参数会输出完整年份形式，例如 2017.0。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Optional


# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
_VI_EXTENSIONS = {".vi", ".ctl", ".vit", ".ctt", ".vim", ".lvlib", ".lvclass"}
_RSRC_MAGIC = b"RSRC"
_VERSION_SCAN_BYTES = 512
_VERSION_MARKER = b"\x00\x00\x00\xa0"


# ---------------------------------------------------------------------------
# BCD 解码
# ---------------------------------------------------------------------------
def _bcd_byte_to_int(value: int) -> Optional[int]:
    """将单个 BCD 字节解码为十进制整数；若编码无效则返回 None。"""
    high = value >> 4
    low = value & 0x0F
    if high > 9 or low > 9:
        return None
    return high * 10 + low


# ---------------------------------------------------------------------------
# VI 文件头解析
# ---------------------------------------------------------------------------
def parse_vi_version(vi_path: str) -> Optional[tuple[int, int]]:
    """
    从 VI 文件头解析保存版本。

    返回值
    ------
    (major, minor)  例如 (17, 0) 表示 LabVIEW 2017 SP0
    None            若文件不是有效的 VI / 未找到版本标记

    异常
    ----
    FileNotFoundError  — 文件不存在
    OSError            — 文件读取失败
    """
    abs_path = os.path.abspath(vi_path)
    if not os.path.isfile(abs_path):
        raise FileNotFoundError(f"文件不存在: {abs_path}")

    with open(abs_path, "rb") as f:
        header = f.read(_VERSION_SCAN_BYTES)

    # 检查 RSRC 魔数
    if not header.startswith(_RSRC_MAGIC):
        return None

    marker_len = len(_VERSION_MARKER)
    max_index = len(header) - (marker_len + 2)

    for index in range(max_index + 1):
        if header[index : index + marker_len] != _VERSION_MARKER:
            continue
        major = _bcd_byte_to_int(header[index + marker_len])
        minor = _bcd_byte_to_int(header[index + marker_len + 1])
        if major is None or minor is None or major <= 0:
            continue
        return major, minor

    return None


def major_to_year(major: int) -> int:
    """
    将两位主版本号转换为完整年份。

    LabVIEW 版本号规则（历史对照）：
        主版本  年份
        ------  ----
        1~8     不是"年份"命名期，直接返回原值
        9       2009 （NI 开始使用年份命名）
        10      2010
        ...
        17      2017
        18      2018
        ...
        25      2025

    因此：major <= 8 → 年份 = major（历史版本）；
          major >= 9 → 年份 = 2000 + major。
    """
    if major >= 9:
        return 2000 + major
    return major


# ---------------------------------------------------------------------------
# 格式化输出
# ---------------------------------------------------------------------------
def format_version(major: int, minor: int, use_year: bool = False) -> str:
    """
    格式化版本字符串。

    use_year=False → "17.0"
    use_year=True  → "2017.0"
    """
    display_major = major_to_year(major) if use_year else major
    return f"{display_major}.{minor}"


def describe_version(major: int, minor: int) -> str:
    """返回人类可读的版本描述，例如 'LabVIEW 2017 SP0'。"""
    year = major_to_year(major)
    if year < 2000:
        return f"LabVIEW {year}.{minor}"
    sp_suffix = f" SP{minor}" if minor > 0 else " (SP0)"
    return f"LabVIEW {year}{sp_suffix}"


# ---------------------------------------------------------------------------
# 公开 API
# ---------------------------------------------------------------------------
def read_vi_version(vi_path: str) -> Optional[tuple[int, int]]:
    """
    读取 VI 文件的保存版本。

    参数
    ----
    vi_path : VI 文件路径（绝对或相对）

    返回值
    ------
    (major, minor)  例如 (17, 0)
    None            若文件不是有效的 LabVIEW VI

    异常
    ----
    FileNotFoundError  — 文件不存在
    OSError            — 文件读取失败
    """
    return parse_vi_version(vi_path)


# ---------------------------------------------------------------------------
# 批量处理
# ---------------------------------------------------------------------------
def _collect_vi_files(paths: list[str], recursive: bool = False) -> list[str]:
    """
    从路径列表收集 VI 文件。支持文件、目录（含递归）和通配符。
    """
    import glob

    collected: list[str] = []
    for p in paths:
        expanded = glob.glob(p)
        if not expanded:
            expanded = [p]
        for item in expanded:
            if os.path.isfile(item):
                collected.append(item)
            elif os.path.isdir(item):
                if recursive:
                    for root, _, files in os.walk(item):
                        for fname in files:
                            if os.path.splitext(fname)[1].lower() in _VI_EXTENSIONS:
                                collected.append(os.path.join(root, fname))
                else:
                    for fname in os.listdir(item):
                        full = os.path.join(item, fname)
                        if os.path.isfile(full) and os.path.splitext(fname)[1].lower() in _VI_EXTENSIONS:
                            collected.append(full)
    return collected


# ---------------------------------------------------------------------------
# 命令行入口
# ---------------------------------------------------------------------------
def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="read_vi_version.py",
        description=(
            "从 LabVIEW VI 文件头读取保存版本号。\n"
            "不依赖 LabVIEW 安装，纯文件头解析，跨平台可用。"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "vi_path",
        nargs="+",
        help="VI 文件路径，可传多个，也可传目录（配合 --recursive）",
    )
    parser.add_argument(
        "--year",
        action="store_true",
        help="以完整年份格式输出，例如 2017.0 而不是 17.0",
    )
    parser.add_argument(
        "--describe",
        action="store_true",
        help="输出人类可读描述，例如 'LabVIEW 2017 SP0'",
    )
    parser.add_argument(
        "--recursive", "-r",
        action="store_true",
        help="当传入目录时递归扫描子目录",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="output_json",
        help="以 JSON 格式输出（多文件时尤为有用）",
    )
    parser.add_argument(
        "--quiet", "-q",
        action="store_true",
        help="静默模式：只输出版本号本身，不输出文件名前缀（单文件时默认行为）",
    )
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    files = _collect_vi_files(args.vi_path, recursive=args.recursive)
    if not files:
        print("[错误] 未找到任何 VI 文件。", file=sys.stderr)
        return 2

    multi = len(files) > 1
    results: list[dict] = []
    exit_code = 0

    for vi_path in files:
        entry: dict = {"path": vi_path}
        try:
            version = parse_vi_version(vi_path)
            if version is None:
                entry["error"] = "非有效 VI 文件或未找到版本标记"
                exit_code = 3
            else:
                major, minor = version
                entry["major"] = major
                entry["minor"] = minor
                entry["version"] = format_version(major, minor, use_year=args.year)
                entry["year"] = major_to_year(major)
                entry["description"] = describe_version(major, minor)
        except FileNotFoundError as exc:
            entry["error"] = str(exc)
            exit_code = 2
        except OSError as exc:
            entry["error"] = f"读取失败: {exc}"
            exit_code = 3

        results.append(entry)

    # ---------- 输出 ----------
    if args.output_json:
        # 单文件时展开对象，多文件时输出数组
        output = results[0] if not multi else results
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return exit_code

    for entry in results:
        path = entry["path"]
        if "error" in entry:
            msg = f"[错误] {entry['error']}"
            if multi or not args.quiet:
                print(f"{path}: {msg}", file=sys.stderr)
            else:
                print(msg, file=sys.stderr)
            continue

        if args.describe:
            value = entry["description"]
        else:
            value = entry["version"]

        if multi and not args.quiet:
            print(f"{path}: {value}")
        else:
            print(value)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
