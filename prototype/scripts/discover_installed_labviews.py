#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
discover_installed_labviews.py
==============================

独立探测本机已安装的 LabVIEW 版本。

用途
----
1. 在不依赖 VS Code 扩展宿主的前提下，验证注册表扫描是否正常；
2. 输出每个注册表键为什么被保留或跳过，方便定位“扩展里看不到安装”的问题；
3. 为后续把探测逻辑回集成到插件提供一份可重复验证的 ground truth。

仅支持 Windows。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import struct
import sys
from dataclasses import asdict, dataclass
from typing import Optional

try:
    import winreg
except ImportError:
    winreg = None  # type: ignore[assignment]


_LABVIEW_REGISTRY_ROOT = r"SOFTWARE\National Instruments\LabVIEW"
_PE_MACHINE_I386 = 0x014C
_PE_MACHINE_AMD64 = 0x8664


@dataclass(frozen=True)
class InstalledLabVIEW:
    major: int
    minor: int
    registry_key: str
    install_dir: str
    exe_path: str
    architecture: str
    registry_view: str


@dataclass(frozen=True)
class RegistryProbe:
    registry_view: str
    registry_key: str
    status: str
    message: str
    install_dir: Optional[str] = None
    exe_path: Optional[str] = None
    parsed_version: Optional[str] = None
    architecture: Optional[str] = None


@dataclass(frozen=True)
class RootProbe:
    registry_view: str
    opened: bool
    message: str


@dataclass(frozen=True)
class DiscoveryReport:
    platform: str
    python_architecture: str
    registry_root: str
    roots: list[RootProbe]
    valid_installations: list[InstalledLabVIEW]
    probes: list[RegistryProbe]


def _ensure_windows() -> None:
    if sys.platform != "win32" or winreg is None:
        raise RuntimeError("本脚本依赖 Windows 注册表，仅支持 Windows。")


def _normalize_path(value: str) -> str:
    return os.path.normcase(os.path.normpath(value))


def _python_architecture() -> str:
    return "x64" if sys.maxsize > 2**32 else "x86"


def _major_to_year(major: int) -> int:
    if major >= 9:
        return 2000 + major
    return major


def _format_labview_label(major: int, minor: int, architecture: Optional[str] = None) -> str:
    if major >= 9:
        year = _major_to_year(major)
        base = f"LabVIEW {year}" if minor == 0 else f"LabVIEW {year} SP{minor}"
    else:
        base = f"LabVIEW {major}.{minor}"
    if architecture == "x64":
        return f"{base} 64bit"
    if architecture == "x86":
        return f"{base} 32bit"
    return base


def _parse_version_key(version_key: str) -> Optional[tuple[int, int]]:
    match = re.fullmatch(r"(\d+)\.(\d+)", version_key.strip())
    if match is None:
        return None
    return int(match.group(1)), int(match.group(2))


def _iter_registry_views() -> list[tuple[str, int]]:
    if winreg is None:
        return [("default", 0)]

    views: list[tuple[str, int]] = []
    for label, attr_name in (("64", "KEY_WOW64_64KEY"), ("32", "KEY_WOW64_32KEY")):
        flag = getattr(winreg, attr_name, None)
        if flag is not None:
            views.append((label, flag))

    if not views:
        views.append(("default", 0))
    return views


def _read_pe_architecture(exe_path: str) -> str:
    with open(exe_path, "rb") as exe_file:
        exe_file.seek(0x3C)
        pe_offset_bytes = exe_file.read(4)
        if len(pe_offset_bytes) != 4:
            raise RuntimeError(f"无法读取 PE 头偏移: {exe_path}")
        pe_offset = struct.unpack("<I", pe_offset_bytes)[0]
        exe_file.seek(pe_offset)
        signature = exe_file.read(6)
        if len(signature) != 6 or signature[:4] != b"PE\x00\x00":
            raise RuntimeError(f"不是有效的 PE 可执行文件: {exe_path}")
        machine = struct.unpack("<H", signature[4:6])[0]

    if machine == _PE_MACHINE_I386:
        return "x86"
    if machine == _PE_MACHINE_AMD64:
        return "x64"
    return f"unknown(0x{machine:04X})"


def discover_installed_labviews() -> DiscoveryReport:
    _ensure_windows()

    roots: list[RootProbe] = []
    probes: list[RegistryProbe] = []
    installations: list[InstalledLabVIEW] = []
    seen: set[tuple[int, int, str]] = set()

    for view_label, view_flag in _iter_registry_views():
        access = winreg.KEY_READ | view_flag
        try:
            root_key = winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                _LABVIEW_REGISTRY_ROOT,
                0,
                access,
            )
        except OSError as exc:
            roots.append(RootProbe(
                registry_view=view_label,
                opened=False,
                message=str(exc),
            ))
            continue

        roots.append(RootProbe(
            registry_view=view_label,
            opened=True,
            message="ok",
        ))

        with root_key:
            index = 0
            while True:
                try:
                    version_key = winreg.EnumKey(root_key, index)
                except OSError:
                    break
                index += 1

                parsed_version = _parse_version_key(version_key)
                if parsed_version is None:
                    probes.append(RegistryProbe(
                        registry_view=view_label,
                        registry_key=version_key,
                        status="skip-invalid-version-key",
                        message="子键名不是 major.minor 格式，已跳过。",
                    ))
                    continue

                version_text = f"{parsed_version[0]}.{parsed_version[1]}"
                try:
                    version_subkey = winreg.OpenKey(
                        winreg.HKEY_LOCAL_MACHINE,
                        f"{_LABVIEW_REGISTRY_ROOT}\\{version_key}",
                        0,
                        access,
                    )
                except OSError as exc:
                    probes.append(RegistryProbe(
                        registry_view=view_label,
                        registry_key=version_key,
                        status="skip-open-subkey-error",
                        message=str(exc),
                        parsed_version=version_text,
                    ))
                    continue

                with version_subkey:
                    try:
                        install_dir, _ = winreg.QueryValueEx(version_subkey, "Path")
                    except OSError:
                        install_dir = ""

                if not install_dir:
                    probes.append(RegistryProbe(
                        registry_view=view_label,
                        registry_key=version_key,
                        status="skip-missing-path",
                        message="Path 值不存在或为空。",
                        parsed_version=version_text,
                    ))
                    continue

                install_dir = os.path.abspath(str(install_dir))
                exe_path = os.path.abspath(os.path.join(install_dir, "LabVIEW.exe"))
                if not os.path.isfile(exe_path):
                    probes.append(RegistryProbe(
                        registry_view=view_label,
                        registry_key=version_key,
                        status="skip-missing-exe",
                        message="Path 存在，但目录下没有 LabVIEW.exe。",
                        install_dir=install_dir,
                        exe_path=exe_path,
                        parsed_version=version_text,
                    ))
                    continue

                try:
                    architecture = _read_pe_architecture(exe_path)
                except Exception as exc:  # noqa: BLE001
                    probes.append(RegistryProbe(
                        registry_view=view_label,
                        registry_key=version_key,
                        status="skip-pe-error",
                        message=str(exc),
                        install_dir=install_dir,
                        exe_path=exe_path,
                        parsed_version=version_text,
                    ))
                    continue

                if architecture not in {"x86", "x64"}:
                    probes.append(RegistryProbe(
                        registry_view=view_label,
                        registry_key=version_key,
                        status="skip-unsupported-architecture",
                        message=f"不支持的 PE Machine: {architecture}",
                        install_dir=install_dir,
                        exe_path=exe_path,
                        parsed_version=version_text,
                        architecture=architecture,
                    ))
                    continue

                major, minor = parsed_version
                dedupe_key = (major, minor, _normalize_path(exe_path))
                if dedupe_key in seen:
                    probes.append(RegistryProbe(
                        registry_view=view_label,
                        registry_key=version_key,
                        status="skip-duplicate",
                        message="与另一注册表视图中的同一安装重复，已去重。",
                        install_dir=install_dir,
                        exe_path=exe_path,
                        parsed_version=version_text,
                        architecture=architecture,
                    ))
                    continue

                seen.add(dedupe_key)
                installations.append(InstalledLabVIEW(
                    major=major,
                    minor=minor,
                    registry_key=version_key,
                    install_dir=install_dir,
                    exe_path=exe_path,
                    architecture=architecture,
                    registry_view=view_label,
                ))
                probes.append(RegistryProbe(
                    registry_view=view_label,
                    registry_key=version_key,
                    status="ok",
                    message="有效安装。",
                    install_dir=install_dir,
                    exe_path=exe_path,
                    parsed_version=version_text,
                    architecture=architecture,
                ))

    installations.sort(key=lambda item: (item.major, item.minor, item.architecture, item.install_dir))
    return DiscoveryReport(
        platform=sys.platform,
        python_architecture=_python_architecture(),
        registry_root=_LABVIEW_REGISTRY_ROOT,
        roots=roots,
        valid_installations=installations,
        probes=probes,
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="discover_installed_labviews.py",
        description="探测本机已安装的 LabVIEW 版本，并输出保留/跳过原因。",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="以 JSON 输出完整探测报告。",
    )
    parser.add_argument(
        "--diagnose",
        action="store_true",
        help="文本模式下额外输出每个注册表子键的跳过原因。",
    )
    return parser


def _report_to_json(report: DiscoveryReport) -> str:
    return json.dumps(asdict(report), ensure_ascii=False, indent=2)


def _render_text_report(report: DiscoveryReport, diagnose: bool) -> str:
    lines: list[str] = []
    lines.append("LabVIEW 安装探测结果")
    lines.append(f"平台: {report.platform}")
    lines.append(f"Python 位数: {report.python_architecture}")
    lines.append(f"注册表根: HKLM\\{report.registry_root}")
    lines.append("")
    lines.append("注册表视图:")
    for root in report.roots:
        state = "ok" if root.opened else "failed"
        lines.append(f"- view={root.registry_view}: {state} | {root.message}")
    lines.append("")

    if report.valid_installations:
        lines.append(f"有效安装: {len(report.valid_installations)}")
        for installation in report.valid_installations:
            lines.append(
                "- "
                f"{_format_labview_label(installation.major, installation.minor, installation.architecture)} | "
                f"key={installation.registry_key} | view={installation.registry_view} | "
                f"dir={installation.install_dir}"
            )
    else:
        lines.append("有效安装: 0")

    if diagnose:
        lines.append("")
        lines.append("详细诊断:")
        for probe in report.probes:
            base = f"- view={probe.registry_view} key={probe.registry_key} status={probe.status}"
            details = [probe.message]
            if probe.parsed_version:
                details.append(f"parsed={probe.parsed_version}")
            if probe.architecture:
                details.append(f"arch={probe.architecture}")
            if probe.install_dir:
                details.append(f"dir={probe.install_dir}")
            if probe.exe_path:
                details.append(f"exe={probe.exe_path}")
            lines.append(base + " | " + " | ".join(details))

    return "\n".join(lines)


def main(argv: Optional[list[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    try:
        report = discover_installed_labviews()
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(_report_to_json(report))
    else:
        print(_render_text_report(report, diagnose=args.diagnose))
    return 0


if __name__ == "__main__":
    sys.exit(main())
