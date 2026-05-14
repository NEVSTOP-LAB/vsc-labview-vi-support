#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
read_vi_props.py
================

通过 LabVIEW ActiveX/COM 读取一组常用且稳定可访问的 VI 属性。

支持的属性（共 12 项）
----------------------
只读 String  : Name, Path, SavedVersion
读写 String  : Description, HistoryText
读写 Boolean : AllowDebugging, ShowFPOnCall, CloseFPAfterCall,
               IsReentrant, RunOnOpen
读写 Number  : PreferredExecSystem, ExecPriority

工作方式
--------
与 read_vi_description.py 相同的版本识别、安装定位、位数匹配机制；
只是 VBScript worker 换成 read_vi_props_worker.vbs，
它会对每个属性单独尝试读取（On Error Resume Next 保护），
某个属性不可用时只记录错误，不影响其他属性的读取。

仅支持 Windows 平台。
"""

from __future__ import annotations

import argparse
import base64
import json
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
except ImportError:
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

_PROPS_WORKER_SCRIPT = os.path.join(os.path.dirname(__file__), "read_vi_props_worker.vbs")

# ---------------------------------------------------------------------------
# 属性元数据：(type, writable, description)
# ---------------------------------------------------------------------------
_PROP_META: dict[str, tuple[str, bool, str]] = {
    "Name":                ("String",  False, "VI 文件名（不含路径）"),
    "Path":                ("String",  False, "VI 文件完整路径"),
    "SavedVersion":        ("String",  False, "从文件头解析的保存版本"),
    "Description":         ("String",  True,  "VI 描述（属性对话框中的说明文字）"),
    "HistoryText":         ("String",  True,  "修订历史日志文本"),
    "AllowDebugging":      ("Boolean", True,  "允许调试"),
    "ShowFPOnCall":        ("Boolean", True,  "被调用时显示前面板"),
    "CloseFPAfterCall":    ("Boolean", True,  "调用完毕后关闭前面板"),
    "IsReentrant":         ("Boolean", True,  "是否允许重入执行"),
    "RunOnOpen":           ("Boolean", True,  "打开后立即运行（常见于顶层 VI）"),
    "PreferredExecSystem": ("Number",  True,  "首选执行系统"),
    "ExecPriority":        ("Number",  True,  "执行优先级（VI Server 枚举值）"),
}


# ---------------------------------------------------------------------------
# 数据结构（与 read_vi_description.py 相同）
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class _InstalledLabVIEW:
    major: int
    minor: int
    registry_key: str
    install_dir: str
    exe_path: str
    architecture: str


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
# 基础工具（与 read_vi_description.py 相同）
# ---------------------------------------------------------------------------
def _ensure_windows() -> None:
    if sys.platform != "win32":
        raise RuntimeError("本脚本依赖 LabVIEW ActiveX/COM，仅支持 Windows 平台。")


def _normalize_path(path: str) -> str:
    return os.path.normcase(os.path.normpath(path))


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
            raise ValueError("labview_version 元组必须为 (major, minor)。")
        major, minor = int(version[0]), int(version[1])
    else:
        text = re.sub(r"(?i)^labview\s*", "", str(version).strip()).replace(" ", "")
        if not text:
            raise ValueError("labview_version 不能为空。")
        m = re.fullmatch(r"(\d+)\.(\d+)", text)
        if m:
            major, minor = int(m.group(1)), int(m.group(2))
        elif text.isdigit():
            major, minor = int(text), 0
        else:
            raise ValueError(f"无法解析 labview_version: {version!r}")
    if major >= 2000:
        major -= 2000
    if major <= 0 or minor < 0:
        raise ValueError(f"无效的 labview_version: {version!r}")
    return major, minor


def _bcd_byte_to_int(value: int) -> Optional[int]:
    high, low = value >> 4, value & 0x0F
    if high > 9 or low > 9:
        return None
    return high * 10 + low


def _parse_version_key(version_key: str) -> Optional[tuple[int, int]]:
    m = re.fullmatch(r"(\d+)\.(\d+)", version_key)
    return (int(m.group(1)), int(m.group(2))) if m else None


def _read_vi_saved_version(vi_path: str) -> Optional[tuple[int, int]]:
    with open(vi_path, "rb") as f:
        header = f.read(_VI_VERSION_SCAN_BYTES)
    if not header.startswith(b"RSRC"):
        return None
    marker_len = len(_VI_VERSION_MARKER)
    for i in range(len(header) - marker_len - 1):
        if header[i : i + marker_len] != _VI_VERSION_MARKER:
            continue
        major = _bcd_byte_to_int(header[i + marker_len])
        minor = _bcd_byte_to_int(header[i + marker_len + 1])
        if major is None or minor is None or major <= 0:
            continue
        return major, minor
    return None


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
    with open(exe_path, "rb") as f:
        f.seek(0x3C)
        pe_offset = struct.unpack("<I", f.read(4))[0]
        f.seek(pe_offset)
        sig = f.read(6)
    if len(sig) != 6 or sig[:4] != b"PE\x00\x00":
        raise RuntimeError(f"不是有效的 PE 可执行文件: {exe_path}")
    machine = struct.unpack("<H", sig[4:6])[0]
    if machine == _PE_MACHINE_I386:
        return "x86"
    if machine == _PE_MACHINE_AMD64:
        return "x64"
    return f"unknown(0x{machine:04X})"


def _discover_installed_labviews() -> list[_InstalledLabVIEW]:
    if winreg is None:
        return []
    installations: list[_InstalledLabVIEW] = []
    seen: set[tuple[int, int, str]] = set()
    for view_flag in _iter_registry_view_flags():
        access = winreg.KEY_READ | view_flag
        try:
            root_key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, _LABVIEW_REGISTRY_ROOT, 0, access)
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
                parsed = _parse_version_key(version_key)
                if parsed is None:
                    continue
                try:
                    sub = winreg.OpenKey(
                        winreg.HKEY_LOCAL_MACHINE,
                        f"{_LABVIEW_REGISTRY_ROOT}\\{version_key}", 0, access,
                    )
                except OSError:
                    continue
                with sub:
                    try:
                        install_dir, _ = winreg.QueryValueEx(sub, "Path")
                    except OSError:
                        install_dir = ""
                if not install_dir:
                    continue
                exe_path = os.path.join(install_dir, "LabVIEW.exe")
                if not os.path.isfile(exe_path):
                    continue
                major, minor = parsed
                norm = _normalize_path(exe_path)
                key = (major, minor, norm)
                if key in seen:
                    continue
                seen.add(key)
                installations.append(_InstalledLabVIEW(
                    major=major, minor=minor, registry_key=version_key,
                    install_dir=os.path.abspath(install_dir),
                    exe_path=os.path.abspath(exe_path),
                    architecture=_read_pe_architecture(exe_path),
                ))
    installations.sort(key=lambda x: (x.major, x.minor, x.architecture, x.install_dir))
    return installations


def _select_installed_labview(
    target_major: int,
    target_minor: int,
    requested_bitness: RequestedLabVIEWBitness = None,
) -> Optional[_InstalledLabVIEW]:
    installations = _discover_installed_labviews()
    norm_bitness = _normalize_requested_bitness(requested_bitness)
    default_bitness = norm_bitness or ("x64" if sys.maxsize > 2**32 else "x86")
    exact = [x for x in installations if x.major == target_major and x.minor == target_minor]
    if norm_bitness:
        exact = [x for x in exact if x.architecture == norm_bitness]
    if exact:
        exact.sort(key=lambda x: (x.architecture != default_bitness, x.install_dir))
        return exact[0]
    same_major = [x for x in installations if x.major == target_major]
    if norm_bitness:
        same_major = [x for x in same_major if x.architecture == norm_bitness]
    if not same_major:
        return None
    same_major.sort(key=lambda x: (abs(x.minor - target_minor), x.architecture != default_bitness, x.install_dir))
    return same_major[0]


def _select_script_host(architecture: str) -> str:
    if architecture == "x86":
        return r"C:\Windows\SysWOW64\cscript.exe"
    if architecture == "x64":
        return r"C:\Windows\System32\cscript.exe"
    raise RuntimeError(f"不支持的 LabVIEW 位数: {architecture}")


def _decode_worker_field(value: str) -> str:
    if not value:
        return ""
    return base64.b64decode(value.encode("ascii")).decode("utf-8").lstrip("\ufeff")


def _resolve_target_installation(
    vi_path: str,
    preferred_version: Optional[RequestedLabVIEWVersion] = None,
    preferred_bitness: RequestedLabVIEWBitness = None,
) -> tuple[Optional[_InstalledLabVIEW], _ConnectionReport]:
    norm_bitness = _normalize_requested_bitness(preferred_bitness)
    report = _ConnectionReport(requested_vi_path=vi_path)

    if preferred_version is not None:
        req_ver = _normalize_requested_labview_version(preferred_version)
        report.requested_version = _format_version(req_ver)
        report.requested_version_source = "用户指定版本"
        report.requested_bitness = norm_bitness
        inst = _select_installed_labview(*req_ver, requested_bitness=norm_bitness)
        report.candidate_installation = _format_installation(inst)
        if inst is None:
            report.selection = "用户指定版本不可用"
            report.reason = (
                f"本机未找到用户指定的 LabVIEW 版本 {report.requested_version}"
                f"{(' [' + norm_bitness + ']') if norm_bitness else ''}。"
            )
            raise RuntimeError(report.reason)
        report.selection = "精确命中用户指定版本"
        report.reason = "不回退到其他活动 COM 实例。"
        return inst, report

    try:
        saved = _read_vi_saved_version(vi_path)
    except OSError as exc:
        report.selection = "读取 VI 文件头失败"
        report.reason = f"无法识别 VI 保存版本: {exc}"
        return None, report

    report.requested_version = _format_version(saved)
    report.requested_version_source = "VI 保存版本"

    if saved is None:
        report.selection = "未识别到 VI 保存版本"
        report.reason = "无法从文件头提取保存版本，只能连接当前活动/默认 COM 实例。"
        return None, report

    inst = _select_installed_labview(*saved, requested_bitness=norm_bitness)
    if norm_bitness:
        report.requested_bitness = norm_bitness
    report.candidate_installation = _format_installation(inst)
    if inst is None:
        report.selection = "目标版本未安装"
        report.reason = f"已识别 VI 保存版本 {report.requested_version}，但本机未找到对应 LabVIEW 安装。"
        raise RuntimeError(report.reason)

    report.selection = "精确命中 VI 保存版本"
    report.reason = "不回退到其他活动 COM 实例。"
    return inst, report


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
# 解析属性响应文件
# ---------------------------------------------------------------------------
def _parse_props_response(response_path: str, stderr: str) -> dict:
    """
    解析 read_vi_props_worker.vbs 写入的响应文件。

    响应文件中每个属性占三行：
        prop_<Name>_type=String|Boolean|Number
        prop_<Name>_ok=1|0
        prop_<Name>_val=<Base64>      (ok=1)
        prop_<Name>_errmsg=<Base64>   (ok=0)

    键名规则：prop_ 前缀 + 属性名（无下划线）+ _ + 后缀
    """
    if not os.path.isfile(response_path):
        raise RuntimeError(stderr.strip() or "COM worker 未生成响应文件。")

    raw: dict[str, str] = {}
    with open(response_path, "r", encoding="ascii", errors="strict") as f:
        for line in f:
            line = line.rstrip("\r\n")
            if not line or "=" not in line:
                continue
            k, v = line.split("=", 1)
            raw[k] = v

    result: dict = {
        "ok":                raw.get("ok") == "1",
        "selection":         raw.get("selection", ""),
        "reason":            _decode_worker_field(raw.get("reason_b64", "")),
        "connected_version": _decode_worker_field(raw.get("connected_version_b64", "")),
        "connected_directory": _decode_worker_field(raw.get("connected_directory_b64", "")),
        "attempts":          int(raw.get("attempts", "0") or "0"),
        "props":             {},
    }

    # 解析 prop_<Name>_<suffix> 行
    # 后缀只有: type, ok, val, errmsg  —— 均不含下划线，rfind("_") 分割正确
    for key, value in raw.items():
        if not key.startswith("prop_"):
            continue
        rest = key[5:]                    # e.g. "Description_type"
        last = rest.rfind("_")
        if last < 0:
            continue
        prop_name = rest[:last]           # e.g. "Description"
        suffix    = rest[last + 1:]       # e.g. "type" | "ok" | "val" | "errmsg"

        if prop_name not in result["props"]:
            result["props"][prop_name] = {
                "ok":    False,
                "type":  "String",
                "value": None,
                "error": None,
            }
        entry = result["props"][prop_name]

        if suffix == "type":
            entry["type"] = value
        elif suffix == "ok":
            entry["ok"] = value == "1"
        elif suffix == "val":
            entry["value"] = _decode_worker_field(value)
        elif suffix == "errmsg":
            entry["error"] = _decode_worker_field(value)

    # 注入元数据（writable、description）
    for prop_name, entry in result["props"].items():
        meta = _PROP_META.get(prop_name)
        entry["writable"]    = meta[1] if meta else None
        entry["description"] = meta[2] if meta else ""

    return result


# ---------------------------------------------------------------------------
# Worker 调用
# ---------------------------------------------------------------------------
def _run_props_worker(
    installation: Optional[_InstalledLabVIEW],
    report: _ConnectionReport,
    abs_vi_path: str,
) -> dict:
    """调用 VBScript worker，更新 report，返回解析后的 props dict。"""
    host_architecture = (
        installation.architecture if installation is not None
        else ("x64" if sys.maxsize > 2**32 else "x86")
    )
    host_executable = _select_script_host(host_architecture)
    report.host_architecture = host_architecture
    report.host_executable   = host_executable

    if not os.path.isfile(_PROPS_WORKER_SCRIPT):
        raise RuntimeError(f"缺少 COM worker 脚本: {_PROPS_WORKER_SCRIPT}")

    resp_handle = tempfile.NamedTemporaryFile(
        prefix="labview-vi-props-", suffix=".out", delete=False
    )
    response_path = resp_handle.name
    resp_handle.close()

    command = [
        host_executable, "//Nologo", _PROPS_WORKER_SCRIPT,
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
            command, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
            timeout=_DEFAULT_WORKER_TIMEOUT_SECONDS + 10,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"COM worker 超时，{host_architecture} 宿主未在规定时间内完成。"
        ) from exc

    try:
        result = _parse_props_response(response_path, completed.stderr)
    finally:
        try:
            os.remove(response_path)
        except OSError:
            pass

    # 更新诊断报告
    report.selection         = result.get("selection") or report.selection
    report.reason            = result.get("reason")    or report.reason
    report.connected_version = result.get("connected_version") or report.connected_version
    report.connected_directory = result.get("connected_directory") or report.connected_directory
    attempts = result.get("attempts")
    if isinstance(attempts, int):
        report.attempts = attempts

    if completed.returncode != 0 or not result.get("ok", False):
        raise RuntimeError(
            str(result.get("reason") or completed.stderr.strip() or "COM worker 执行失败。")
        )

    return result.get("props", {})


def _inject_saved_version(abs_vi_path: str, props: dict[str, dict]) -> dict[str, dict]:
    saved_version = _format_version(_read_vi_saved_version(abs_vi_path))
    if not saved_version:
        return props

    enriched = dict(props)
    enriched["SavedVersion"] = {
        "ok": True,
        "type": "String",
        "value": saved_version,
        "error": None,
        "writable": False,
        "description": _PROP_META["SavedVersion"][2],
    }
    return enriched


# ---------------------------------------------------------------------------
# 公开 API
# ---------------------------------------------------------------------------
def read_vi_props(
    vi_path: str,
    labview_version: Optional[RequestedLabVIEWVersion] = None,
    labview_bitness: RequestedLabVIEWBitness = None,
    props: Optional[list[str]] = None,
) -> dict[str, dict]:
    """
    读取 LabVIEW VI 的全部（或指定）属性。

    参数
    ----
    vi_path         : VI 文件路径。
    labview_version : 显式指定目标 LabVIEW 版本（省略时从 VI 头自动识别）。
    labview_bitness : 显式指定位数（省略时优先与当前 Python 进程位数一致）。
    props           : 要返回的属性名列表，None 表示全部。

    返回值
    ------
    dict — 键为属性名，值为::

        {
            "ok":          bool,   # 读取是否成功
            "type":        str,    # "String" | "Boolean" | "Number"
            "value":       str,    # 成功时的值（均为字符串形式）
            "error":       str,    # 失败时的错误描述
            "writable":    bool,   # 该属性是否可写
            "description": str,    # 属性说明
        }
    """
    _ensure_windows()
    abs_vi_path = os.path.abspath(vi_path)
    if not os.path.isfile(abs_vi_path):
        raise FileNotFoundError(f"VI 文件不存在: {abs_vi_path}")

    installation, report = _resolve_target_installation(
        abs_vi_path, labview_version, labview_bitness
    )
    all_props = _inject_saved_version(abs_vi_path, _run_props_worker(installation, report, abs_vi_path))

    if props is not None:
        unknown = set(props) - set(_PROP_META)
        if unknown:
            raise ValueError(f"未知属性名: {', '.join(sorted(unknown))}")
        return {k: all_props[k] for k in props if k in all_props}

    return all_props


# ---------------------------------------------------------------------------
# 格式化输出
# ---------------------------------------------------------------------------
_PREFERRED_EXEC_SYSTEM_LABELS = {
    1: "用户界面",
    2: "标准",
    3: "仪器 I/O",
    4: "数据采集",
    5: "其他 1",
    6: "其他 2",
    7: "与调用者相同",
}


def _annotate_value(prop_name: str, raw_value: str) -> str:
    """为枚举型数值属性追加可读标签。"""
    if prop_name == "PreferredExecSystem":
        label = _PREFERRED_EXEC_SYSTEM_LABELS.get(
            int(raw_value) if raw_value.lstrip("-").isdigit() else -1
        )
        return f"{raw_value} ({label})" if label else raw_value
    return raw_value


def _format_props_text(
    vi_path: str,
    props: dict[str, dict],
    annotate: bool = True,
) -> list[str]:
    """生成人类可读的文本输出行。"""
    lines: list[str] = [f"VI: {vi_path}", ""]
    max_key = max((len(k) for k in props), default=10)
    for name, entry in props.items():
        rw = "R/W" if entry.get("writable") else "R  "
        if entry.get("ok"):
            val = entry["value"] or ""
            if annotate:
                val = _annotate_value(name, val)
            display = val if val else "(空)"
        else:
            display = f"[不可用] {entry.get('error', '')}"
        lines.append(f"  {name:<{max_key}}  {rw}  {entry.get('type', ''):<8}  {display}")
    return lines


# ---------------------------------------------------------------------------
# 命令行入口
# ---------------------------------------------------------------------------
def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="read_vi_props.py",
        description="读取 LabVIEW VI 的全部可访问属性（通过 ActiveX/COM）。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="\n".join([
            "可选属性名（--props）:",
            *[f"  {k:<20} {v[0]:<8} {'R/W' if v[1] else 'R  '}  {v[2]}" for k, v in _PROP_META.items()],
        ]),
    )
    parser.add_argument("vi_path", help="VI 文件路径")
    parser.add_argument("--labview-version", help="显式指定目标 LabVIEW 版本，例如 2017、17.0")
    parser.add_argument("--labview-bitness", help="显式指定目标位数，例如 x86、x64")
    parser.add_argument("--props", help="逗号分隔的属性名列表，省略则读取全部")
    parser.add_argument(
        "--format", choices=["json", "text"], default="json",
        help="输出格式：json（默认）或 text",
    )
    parser.add_argument("--no-annotate", action="store_true",
                        help="text 模式下不追加枚举标签")
    parser.add_argument("--verbose", action="store_true",
                        help="将版本选择与命中诊断输出到 stderr")
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

    prop_list: Optional[list[str]] = None
    if args.props:
        prop_list = [p.strip() for p in args.props.split(",") if p.strip()]

    try:
        _ensure_windows()
        abs_vi_path = os.path.abspath(args.vi_path)
        if not os.path.isfile(abs_vi_path):
            raise FileNotFoundError(f"VI 文件不存在: {abs_vi_path}")

        installation, report = _resolve_target_installation(
            abs_vi_path,
            preferred_version=getattr(args, "labview_version", None),
            preferred_bitness=getattr(args, "labview_bitness", None),
        )
        all_props = _inject_saved_version(abs_vi_path, _run_props_worker(installation, report, abs_vi_path))

        if prop_list is not None:
            unknown = set(prop_list) - set(_PROP_META)
            if unknown:
                raise ValueError(f"未知属性名: {', '.join(sorted(unknown))}")
            props = {k: all_props[k] for k in prop_list if k in all_props}
        else:
            props = all_props

        _print_report()

        if args.format == "json":
            output = {
                "vi_path":    abs_vi_path,
                "lv_version": report.connected_version,
                "props":      props,
            }
            print(json.dumps(output, ensure_ascii=False, indent=2))
        else:
            for line in _format_props_text(abs_vi_path, props, annotate=not args.no_annotate):
                print(line)

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
