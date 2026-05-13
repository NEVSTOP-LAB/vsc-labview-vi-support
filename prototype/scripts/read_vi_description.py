#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
read_vi_description.py
======================

从 LabVIEW VI 文件读取 Description 属性。

工作方式
--------
1. 读取 VI 文件头（前 512 字节），识别 VI 的保存版本（BCD 格式）。
2. 扫描 32 位和 64 位注册表视图，枚举本机安装的 LabVIEW 版本和路径。
3. 读取目标 LabVIEW.exe 的 PE 头，判断安装位数（x86 / x64）。
4. 选择位数匹配的 cscript.exe 作为宿主：
     x86 → C:\\Windows\\SysWOW64\\cscript.exe
     x64 → C:\\Windows\\System32\\cscript.exe
5. 调用 VBScript worker（read_vi_description_worker.vbs），
   通过 LabVIEW ActiveX/COM 接口读取 VI.Description。
6. Worker 将结果以 Base64 编码写入临时响应文件，Python 解码后输出。

仅支持 Windows 平台。
"""

from __future__ import annotations

import argparse
import base64
import os
import re
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from typing import Optional, Tuple, Union

try:
    import winreg
except ImportError:  # 非 Windows 平台
    winreg = None  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# 类型别名
# ---------------------------------------------------------------------------
RequestedLabVIEWVersion = Union[str, int, Tuple[int, int]]
RequestedLabVIEWBitness = Optional[str]

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
_VI_VERSION_SCAN_BYTES = 512
_VI_VERSION_MARKER = b"\x00\x00\x00\xa0"
_LABVIEW_REGISTRY_ROOT = r"SOFTWARE\National Instruments\LabVIEW"
_DEFAULT_WORKER_TIMEOUT_SECONDS = 45
_PE_MACHINE_I386 = 0x014C
_PE_MACHINE_AMD64 = 0x8664

_WORKER_SCRIPT = os.path.join(os.path.dirname(__file__), "read_vi_description_worker.vbs")


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class _InstalledLabVIEW:
    major: int
    minor: int
    registry_key: str
    install_dir: str
    exe_path: str
    architecture: str  # "x86" | "x64"


@dataclass
class _ConnectionReport:
    requested_vi_path: Optional[str] = None
    requested_version: Optional[str] = None
    requested_version_source: Optional[str] = None
    candidate_installation: Optional[str] = None
    selection: Optional[str] = None
    reason: Optional[str] = None
    connected_version: Optional[str] = None
    connected_directory: Optional[str] = None
    host_architecture: Optional[str] = None
    host_executable: Optional[str] = None
    attempts: Optional[int] = None
    requested_bitness: Optional[str] = None


# ---------------------------------------------------------------------------
# 平台守卫
# ---------------------------------------------------------------------------
def _ensure_windows() -> None:
    if sys.platform != "win32":
        raise RuntimeError("本脚本依赖 LabVIEW ActiveX/COM，仅支持 Windows 平台。")


# ---------------------------------------------------------------------------
# 路径工具
# ---------------------------------------------------------------------------
def _normalize_path(path: str) -> str:
    return os.path.normcase(os.path.normpath(path))


# ---------------------------------------------------------------------------
# 版本格式化
# ---------------------------------------------------------------------------
def _format_version(version: Optional[tuple[int, int]]) -> Optional[str]:
    if version is None:
        return None
    return f"{version[0]}.{version[1]}"


def _format_installation(installation: Optional[_InstalledLabVIEW]) -> Optional[str]:
    if installation is None:
        return None
    return (
        f"LabVIEW {installation.registry_key} "
        f"[{installation.architecture}] ({installation.exe_path})"
    )


# ---------------------------------------------------------------------------
# 参数规范化
# ---------------------------------------------------------------------------
def _normalize_requested_bitness(bitness: RequestedLabVIEWBitness) -> Optional[str]:
    if bitness is None:
        return None
    normalized = str(bitness).strip().lower()
    aliases = {
        "32": "x86", "32bit": "x86", "32-bit": "x86", "x86": "x86",
        "64": "x64", "64bit": "x64", "64-bit": "x64", "x64": "x64",
    }
    if normalized not in aliases:
        raise ValueError("labview_bitness 仅支持 x86、x64、32、64。")
    return aliases[normalized]


def _normalize_requested_labview_version(
    version: Optional[RequestedLabVIEWVersion],
) -> Optional[tuple[int, int]]:
    if version is None:
        return None

    if isinstance(version, tuple):
        if len(version) != 2:
            raise ValueError("labview_version 元组必须为 (major, minor) 两个整数，例如 (17, 0)。")
        major = int(version[0])
        minor = int(version[1])
    else:
        text = re.sub(r"(?i)^labview\s*", "", str(version).strip())
        text = text.replace(" ", "")
        if not text:
            raise ValueError("labview_version 不能为空。支持示例：2017、17.0、2025.3。")

        match = re.fullmatch(r"(\d+)\.(\d+)", text)
        if match is not None:
            major = int(match.group(1))
            minor = int(match.group(2))
        elif text.isdigit():
            major = int(text)
            minor = 0
        else:
            raise ValueError(f"无法解析 labview_version: {version!r}。支持示例：2017、17.0、2025.3。")

    if major >= 2000:
        major -= 2000

    if major <= 0 or minor < 0:
        raise ValueError(f"无效的 labview_version: {version!r}。支持示例：2017、17.0、2025.3。")

    return major, minor


# ---------------------------------------------------------------------------
# VI 文件头解析 — 读取保存版本
# ---------------------------------------------------------------------------
def _bcd_byte_to_int(value: int) -> Optional[int]:
    high = value >> 4
    low = value & 0x0F
    if high > 9 or low > 9:
        return None
    return (high * 10) + low


def _parse_version_key(version_key: str) -> Optional[tuple[int, int]]:
    match = re.fullmatch(r"(\d+)\.(\d+)", version_key)
    if match is None:
        return None
    return int(match.group(1)), int(match.group(2))


def _read_vi_saved_version(vi_path: str) -> Optional[tuple[int, int]]:
    """从 VI 文件头读取保存时的 LabVIEW 版本（BCD 编码）。"""
    with open(vi_path, "rb") as vi_file:
        header = vi_file.read(_VI_VERSION_SCAN_BYTES)

    if not header.startswith(b"RSRC"):
        return None

    max_index = len(header) - (len(_VI_VERSION_MARKER) + 2)
    for index in range(max_index + 1):
        if header[index : index + len(_VI_VERSION_MARKER)] != _VI_VERSION_MARKER:
            continue
        major = _bcd_byte_to_int(header[index + 4])
        minor = _bcd_byte_to_int(header[index + 5])
        if major is None or minor is None or major <= 0:
            continue
        return major, minor

    return None


# ---------------------------------------------------------------------------
# 注册表 + PE 头 — 发现已安装的 LabVIEW
# ---------------------------------------------------------------------------
def _iter_registry_view_flags() -> list[int]:
    if winreg is None:
        return [0]
    flags = [0]
    for attr in ("KEY_WOW64_64KEY", "KEY_WOW64_32KEY"):
        flag = getattr(winreg, attr, None)
        if flag is not None and flag not in flags:
            flags.append(flag)
    return flags


def _read_pe_architecture(exe_path: str) -> str:
    """读取 LabVIEW.exe 的 PE Machine 字段，返回 'x86' 或 'x64'。"""
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


def _discover_installed_labviews() -> list[_InstalledLabVIEW]:
    """扫描 32 位和 64 位注册表视图，枚举所有已安装的 LabVIEW 版本。"""
    if winreg is None:
        return []

    installations: list[_InstalledLabVIEW] = []
    seen: set[tuple[int, int, str]] = set()

    for view_flag in _iter_registry_view_flags():
        access = winreg.KEY_READ | view_flag
        try:
            root_key = winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                _LABVIEW_REGISTRY_ROOT,
                0,
                access,
            )
        except OSError:
            continue

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
                    continue

                try:
                    version_subkey = winreg.OpenKey(
                        winreg.HKEY_LOCAL_MACHINE,
                        f"{_LABVIEW_REGISTRY_ROOT}\\{version_key}",
                        0,
                        access,
                    )
                except OSError:
                    continue

                with version_subkey:
                    try:
                        install_dir, _ = winreg.QueryValueEx(version_subkey, "Path")
                    except OSError:
                        install_dir = ""

                if not install_dir:
                    continue

                exe_path = os.path.join(install_dir, "LabVIEW.exe")
                if not os.path.isfile(exe_path):
                    continue

                major, minor = parsed_version
                normalized_exe = _normalize_path(exe_path)
                dedupe_key = (major, minor, normalized_exe)
                if dedupe_key in seen:
                    continue
                seen.add(dedupe_key)
                installations.append(
                    _InstalledLabVIEW(
                        major=major,
                        minor=minor,
                        registry_key=version_key,
                        install_dir=os.path.abspath(install_dir),
                        exe_path=os.path.abspath(exe_path),
                        architecture=_read_pe_architecture(exe_path),
                    )
                )

    installations.sort(
        key=lambda item: (item.major, item.minor, item.architecture, item.install_dir)
    )
    return installations


def _select_installed_labview(
    target_major: int,
    target_minor: int,
    requested_bitness: RequestedLabVIEWBitness = None,
) -> Optional[_InstalledLabVIEW]:
    """
    选择最匹配的 LabVIEW 安装：
    1. 优先精确匹配主次版本；
    2. 若无精确版本，回退到相同主版本、次版本最接近的安装；
    3. 同版本双位数并存时，若未指定则优先与当前 Python 进程位数一致。
    """
    installations = _discover_installed_labviews()
    normalized_bitness = _normalize_requested_bitness(requested_bitness)
    default_bitness = normalized_bitness or ("x64" if sys.maxsize > 2**32 else "x86")

    exact_matches = [
        item
        for item in installations
        if item.major == target_major and item.minor == target_minor
    ]
    if normalized_bitness is not None:
        exact_matches = [
            item for item in exact_matches if item.architecture == normalized_bitness
        ]
    if exact_matches:
        exact_matches.sort(
            key=lambda item: (item.architecture != default_bitness, item.install_dir)
        )
        return exact_matches[0]

    same_major = [item for item in installations if item.major == target_major]
    if normalized_bitness is not None:
        same_major = [item for item in same_major if item.architecture == normalized_bitness]
    if not same_major:
        return None

    same_major.sort(
        key=lambda item: (
            abs(item.minor - target_minor),
            item.architecture != default_bitness,
            item.install_dir,
        )
    )
    return same_major[0]


# ---------------------------------------------------------------------------
# 宿主选择
# ---------------------------------------------------------------------------
def _select_script_host(architecture: str) -> str:
    """根据 LabVIEW 安装位数，选择对应的 cscript.exe。"""
    if architecture == "x86":
        return r"C:\Windows\SysWOW64\cscript.exe"
    if architecture == "x64":
        return r"C:\Windows\System32\cscript.exe"
    raise RuntimeError(f"不支持的 LabVIEW 位数: {architecture}")


# ---------------------------------------------------------------------------
# Base64 编解码（用于跨进程传递非 ASCII 文本）
# ---------------------------------------------------------------------------
def _decode_worker_field(value: str) -> str:
    if not value:
        return ""
    return base64.b64decode(value.encode("ascii")).decode("utf-8").lstrip("\ufeff")


# ---------------------------------------------------------------------------
# 解析 worker 响应文件
# ---------------------------------------------------------------------------
def _parse_worker_response(response_path: str, stderr: str) -> dict:
    if not os.path.isfile(response_path):
        raise RuntimeError(stderr.strip() or "COM worker 未生成响应文件。")

    result: dict[str, object] = {}
    with open(response_path, "r", encoding="ascii", errors="strict") as f:
        for raw_line in f:
            line = raw_line.rstrip("\r\n")
            if not line or "=" not in line:
                continue
            key, value = line.split("=", 1)
            result[key] = value

    decoded: dict[str, object] = {}
    for key, value in result.items():
        if not isinstance(value, str):
            decoded[key] = value
            continue
        if key.endswith("_b64"):
            decoded[key[:-4]] = _decode_worker_field(value)
        elif key == "ok":
            decoded[key] = value == "1"
        elif key == "attempts":
            decoded[key] = int(value) if value else 0
        else:
            decoded[key] = value

    return decoded


# ---------------------------------------------------------------------------
# 核心函数：解析目标安装 + 调用 Worker
# ---------------------------------------------------------------------------
def _resolve_target_installation(
    vi_path: str,
    preferred_version: Optional[RequestedLabVIEWVersion] = None,
    preferred_bitness: RequestedLabVIEWBitness = None,
) -> tuple[Optional[_InstalledLabVIEW], _ConnectionReport]:
    """
    解析目标 LabVIEW 安装，同时构建诊断报告。
    优先级：用户显式指定版本 > VI 文件头保存版本。
    """
    normalized_bitness = _normalize_requested_bitness(preferred_bitness)
    report = _ConnectionReport(requested_vi_path=vi_path)

    if preferred_version is not None:
        requested_version = _normalize_requested_labview_version(preferred_version)
        report.requested_version = _format_version(requested_version)
        report.requested_version_source = "用户指定版本"
        report.requested_bitness = normalized_bitness
        installation = _select_installed_labview(
            *requested_version,
            requested_bitness=normalized_bitness,
        )
        report.candidate_installation = _format_installation(installation)
        if installation is None:
            report.selection = "用户指定版本不可用"
            report.reason = (
                f"本机未找到用户指定的 LabVIEW 版本 {report.requested_version}"
                f"{(' [' + normalized_bitness + ']') if normalized_bitness else ''}。"
            )
            raise RuntimeError(report.reason)
        report.selection = "精确命中用户指定版本"
        report.reason = "不回退到其他活动 COM 实例。"
        return installation, report

    # 从 VI 文件头读取保存版本
    try:
        saved_version = _read_vi_saved_version(vi_path)
    except OSError as exc:
        report.selection = "读取 VI 文件头失败"
        report.reason = f"无法识别 VI 保存版本: {exc}"
        return None, report

    report.requested_version = _format_version(saved_version)
    report.requested_version_source = "VI 保存版本"

    if saved_version is None:
        report.selection = "未识别到 VI 保存版本"
        report.reason = "无法从文件头提取保存版本，只能连接当前活动/默认 COM 实例。"
        return None, report

    installation = _select_installed_labview(
        *saved_version,
        requested_bitness=normalized_bitness,
    )
    if normalized_bitness is not None:
        report.requested_bitness = normalized_bitness
    report.candidate_installation = _format_installation(installation)
    if installation is None:
        report.selection = "目标版本未安装"
        report.reason = (
            f"已识别 VI 保存版本 {report.requested_version}，但本机未找到对应 LabVIEW 安装。"
        )
        raise RuntimeError(report.reason)

    report.selection = "精确命中 VI 保存版本"
    report.reason = "不回退到其他活动 COM 实例。"
    return installation, report


def _run_worker(
    installation: Optional[_InstalledLabVIEW],
    report: _ConnectionReport,
    abs_vi_path: str,
) -> str:
    """
    调用 VBScript worker 读取 Description。
    直接修改传入的 report（更新连接信息），返回描述文本。
    独立拆出此函数使 main() 在 worker 失败时仍能访问已填写的 report。
    """
    host_architecture = (
        installation.architecture
        if installation is not None
        else ("x64" if sys.maxsize > 2**32 else "x86")
    )
    host_executable = _select_script_host(host_architecture)
    report.host_architecture = host_architecture
    report.host_executable = host_executable

    if not os.path.isfile(_WORKER_SCRIPT):
        raise RuntimeError(f"缺少 COM worker 脚本: {_WORKER_SCRIPT}")

    response_handle = tempfile.NamedTemporaryFile(
        prefix="labview-vi-desc-",
        suffix=".out",
        delete=False,
    )
    response_path = response_handle.name
    response_handle.close()

    command = [
        host_executable,
        "//Nologo",
        _WORKER_SCRIPT,
        f"/viPath:{abs_vi_path}",
        f"/responsePath:{response_path}",
        f"/timeoutSeconds:{_DEFAULT_WORKER_TIMEOUT_SECONDS}",
    ]
    if installation is not None:
        command.extend([
            f"/targetExe:{installation.exe_path}",
            f"/expectedDirectory:{installation.install_dir}",
            f"/expectedVersion:{installation.major}.{installation.minor}",
        ])

    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_DEFAULT_WORKER_TIMEOUT_SECONDS + 10,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"COM worker 超时，{host_architecture} 宿主未在规定时间内完成。"
        ) from exc

    try:
        result = _parse_worker_response(response_path, completed.stderr)
    finally:
        try:
            os.remove(response_path)
        except OSError:
            pass

    # 更新诊断报告
    report.selection = result.get("selection") or report.selection
    report.reason = result.get("reason") or report.reason
    report.connected_version = result.get("connected_version") or report.connected_version
    report.connected_directory = result.get("connected_directory") or report.connected_directory
    attempts = result.get("attempts")
    if isinstance(attempts, int):
        report.attempts = attempts

    if completed.returncode != 0 or not result.get("ok", False):
        raise RuntimeError(
            str(result.get("reason") or completed.stderr.strip() or "COM worker 执行失败。")
        )

    return str(result.get("value", ""))


def _invoke_read_description(
    vi_path: str,
    preferred_version: Optional[RequestedLabVIEWVersion] = None,
    preferred_bitness: RequestedLabVIEWBitness = None,
) -> tuple[str, _ConnectionReport]:
    """
    公开 API 的实现入口：解析目标安装，调用 worker，返回 (description, report)。
    """
    _ensure_windows()
    abs_vi_path = os.path.abspath(vi_path)
    if not os.path.isfile(abs_vi_path):
        raise FileNotFoundError(f"VI 文件不存在: {abs_vi_path}")
    installation, report = _resolve_target_installation(
        abs_vi_path, preferred_version, preferred_bitness
    )
    description = _run_worker(installation, report, abs_vi_path)
    return description, report


# ---------------------------------------------------------------------------
# 诊断报告格式化
# ---------------------------------------------------------------------------
def format_connection_report(report: _ConnectionReport) -> list[str]:
    lines: list[str] = []
    if report.requested_vi_path:
        lines.append(f"目标 VI: {report.requested_vi_path}")
    if report.requested_version:
        label = report.requested_version_source or "请求版本"
        lines.append(f"{label}: {report.requested_version}")
    if report.requested_bitness:
        lines.append(f"请求位数: {report.requested_bitness}")
    if report.candidate_installation:
        lines.append(f"目标安装: {report.candidate_installation}")
    if report.host_architecture:
        lines.append(f"宿主位数: {report.host_architecture}")
    if report.host_executable:
        lines.append(f"宿主程序: {report.host_executable}")
    if report.selection:
        lines.append(f"连接策略: {report.selection}")
    if report.reason:
        lines.append(f"说明: {report.reason}")
    if report.connected_version:
        lines.append(f"实际连接版本: {report.connected_version}")
    if report.connected_directory:
        lines.append(f"实际连接目录: {report.connected_directory}")
    if report.attempts is not None:
        lines.append(f"连接尝试次数: {report.attempts}")
    return lines


# ---------------------------------------------------------------------------
# 公开 API
# ---------------------------------------------------------------------------
def read_description(
    vi_path: str,
    labview_version: Optional[RequestedLabVIEWVersion] = None,
    labview_bitness: RequestedLabVIEWBitness = None,
) -> str:
    """
    读取 LabVIEW VI 的 Description 属性。

    参数
    ----
    vi_path         : VI 文件的绝对或相对路径。
    labview_version : 显式指定目标 LabVIEW 版本，例如 2017、17.0、2025.3。
                      省略时从 VI 文件头自动识别。
    labview_bitness : 显式指定位数，例如 x86、x64、32、64。
                      省略时优先与当前 Python 进程位数一致。

    返回值
    ------
    str  — VI Description 文本（可能为空字符串）。

    异常
    ----
    FileNotFoundError  — VI 文件不存在。
    RuntimeError       — LabVIEW 安装未找到、COM 连接失败等。
    ValueError         — 参数格式错误。
    """
    description, _ = _invoke_read_description(vi_path, labview_version, labview_bitness)
    return description


# ---------------------------------------------------------------------------
# 命令行入口
# ---------------------------------------------------------------------------
def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="read_vi_description.py",
        description="读取 LabVIEW VI 的 Description 属性（通过 ActiveX/COM）。",
    )
    parser.add_argument("vi_path", help="VI 文件路径")
    parser.add_argument(
        "--labview-version",
        help="显式指定目标 LabVIEW 版本，例如 2017、17.0、2025.3",
    )
    parser.add_argument(
        "--labview-bitness",
        help="显式指定目标 LabVIEW 位数，例如 x86、x64、32、64",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="将版本选择与命中诊断输出到 stderr",
    )
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    verbose: bool = bool(args.verbose)
    report: Optional[_ConnectionReport] = None

    def _print_report() -> None:
        if verbose and report is not None:
            for line in format_connection_report(report):
                print(f"[LabVIEW] {line}", file=sys.stderr)

    try:
        _ensure_windows()
        abs_vi_path = os.path.abspath(args.vi_path)
        if not os.path.isfile(abs_vi_path):
            raise FileNotFoundError(f"VI 文件不存在: {abs_vi_path}")

        # Phase 1: 解析目标安装（report 在此被赋值，后续 except 可访问）
        installation, report = _resolve_target_installation(
            abs_vi_path,
            preferred_version=getattr(args, "labview_version", None),
            preferred_bitness=getattr(args, "labview_bitness", None),
        )

        # Phase 2: 调用 worker（失败时 report 已含部分诊断信息）
        description = _run_worker(installation, report, abs_vi_path)

        _print_report()
        print(description)
        return 0

    except ValueError as exc:
        _print_report()
        print(f"[错误] {exc}", file=sys.stderr)
        return 4

    except FileNotFoundError as exc:
        _print_report()
        print(f"[错误] {exc}", file=sys.stderr)
        return 2

    except RuntimeError as exc:
        _print_report()
        print(f"[错误] {exc}", file=sys.stderr)
        return 3

    except Exception as exc:  # pragma: no cover
        print(f"[未预期错误] {exc}", file=sys.stderr)
        return 4


if __name__ == "__main__":
    sys.exit(main())
