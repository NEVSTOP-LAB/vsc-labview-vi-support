Option Explicit

' Suffix values are compared against LCase(...) for case-insensitive key parsing.
Const REQUEST_SUFFIX_TYPE = "_type"
Const REQUEST_SUFFIX_VAL  = "_val"
Const REQUEST_PART_TYPE   = "type"
Const REQUEST_PART_VAL    = "val"

' ===========================================================================
' write_vi_props_worker.vbs
' ===========================================================================
' 通过 LabVIEW ActiveX/COM 将一组属性写回 VI 文件，并调用 SaveInstrument 落盘。
'
' 本脚本由扩展运行时通过 cscript.exe 调度。
' 镜像 read_vi_props_worker.vbs 的连接 / 重试 / 响应文件格式。
'
' 命名参数（由扩展运行时以 /key:value 形式传入）
' -----------------------------------------
'   /viPath             VI 文件完整路径（必填）
'   /requestPath        请求文件路径（必填，包含要写入的属性，UTF-8/Base64 编码）
'   /responsePath       结果输出文件路径（必填）
'   /timeoutSeconds     连接超时秒数（默认 45）
'   /targetExe          目标 LabVIEW.exe 路径（可选；有则精确匹配）
'   /expectedDirectory  预期的 ApplicationDirectory（可选）
'   /expectedVersion    预期的 Version 前缀，例如 "17.0"（可选）
'   /save               1=写完后调用 SaveInstrument（默认）；0=不保存
'
' 请求文件格式（ASCII 编码，每行一对 key=value）
' ---------------------------------------------
'   set_<PropName>_type=String|Boolean|Number
'   set_<PropName>_val=<Base64-UTF8>
'   ...
' 仅可写属性会被尝试写入。未列出的属性不会被改动。
'
' 响应文件格式（ASCII 编码） — 与 read_vi_props_worker.vbs 兼容
' -------------------------------------------------------------
'   ok=1|0
'   selection=<ascii>
'   reason_b64=<Base64-UTF8>
'   connected_version_b64=<Base64-UTF8>
'   connected_directory_b64=<Base64-UTF8>
'   attempts=<整数>
'   saved=1|0
'   save_errmsg_b64=<Base64-UTF8>           (saved=0 时)
'   prop_<Name>_type=String|Boolean|Number
'   prop_<Name>_ok=1|0
'   prop_<Name>_val=<Base64-UTF8>           (ok=1 时——回显写入后的值)
'   prop_<Name>_errmsg=<Base64-UTF8>        (ok=0 时)
'   ...
'
' 注意（需要在真实 LabVIEW 环境中验证）
' ------------------------------------
' 本脚本基于 read_vi_props_worker.vbs 的访问模式编写，但写入语义与具体
' LabVIEW 版本相关：例如 HistoryText 在某些 VI 上可能因元数据损坏而失败；
' SaveInstrument 要求 VI 处于可保存状态。
' 单个属性写入失败会被独立报告，不会阻塞其他属性的写入。
' ===========================================================================

' ---------------------------------------------------------------------------
' 读取命名参数
' ---------------------------------------------------------------------------
Dim viPath
Dim targetExe
Dim expectedDirectory
Dim expectedVersion
Dim requestPath
Dim responsePath
Dim timeoutSeconds
Dim retryIntervalMs
Dim doSave

viPath            = GetNamedArg("viPath", "")
targetExe         = GetNamedArg("targetExe", "")
expectedDirectory = GetNamedArg("expectedDirectory", "")
expectedVersion   = GetNamedArg("expectedVersion", "")
requestPath       = GetNamedArg("requestPath", "")
responsePath      = GetNamedArg("responsePath", "")
timeoutSeconds    = CLng(GetNamedArg("timeoutSeconds", "45"))
retryIntervalMs   = 750
doSave            = (GetNamedArg("save", "1") <> "0")

' ---------------------------------------------------------------------------
' 运行时状态
' ---------------------------------------------------------------------------
Dim app
Dim vi
Dim attempts
Dim selection
Dim reason
Dim connectedVersion
Dim connectedDirectory

Set app            = Nothing
Set vi             = Nothing
attempts           = 0
selection          = ""
reason             = ""
connectedVersion   = ""
connectedDirectory = ""

' 可写属性元数据：name=>"type|category"
'   category: vi   (vi.<Name>)
Dim writableMeta
Set writableMeta = CreateObject("Scripting.Dictionary")
writableMeta.CompareMode = 1 ' textual
writableMeta.Add "Description",       "String|vi"
writableMeta.Add "HistoryText",       "String|vi"
writableMeta.Add "AllowDebugging",    "Boolean|vi"
writableMeta.Add "ShowFPOnCall",      "Boolean|vi"
writableMeta.Add "CloseFPAfterCall",  "Boolean|vi"
writableMeta.Add "IsReentrant",       "Boolean|vi"
writableMeta.Add "RunOnOpen",         "Boolean|vi"
writableMeta.Add "PreferredExecSystem", "Number|vi"
writableMeta.Add "ExecPriority",      "Number|vi"

' ---------------------------------------------------------------------------
' 顶层执行
' ---------------------------------------------------------------------------
On Error Resume Next
Main
If Err.Number <> 0 Then
    reason = Err.Description
    WriteFailResponse selection, reason, connectedVersion, connectedDirectory, attempts
    WScript.Quit 3
End If
On Error GoTo 0

' ===========================================================================
' Sub Main
' ===========================================================================
Sub Main()
    If Len(responsePath) = 0 Then
        Err.Raise vbObjectError + 100, , "Missing responsePath argument."
    End If
    If Len(viPath) = 0 Then
        Err.Raise vbObjectError + 101, , "Missing viPath argument."
    End If
    If Len(requestPath) = 0 Then
        Err.Raise vbObjectError + 102, , "Missing requestPath argument."
    End If
    If Not FileExists(viPath) Then
        Err.Raise vbObjectError + 103, , "VI file not found: " & viPath
    End If
    If Not FileExists(requestPath) Then
        Err.Raise vbObjectError + 104, , "Request file not found: " & requestPath
    End If

    Dim updates
    Set updates = ParseRequestFile(requestPath)

    ConnectLabVIEW

    Err.Clear
    Set vi = app.GetVIReference(viPath)
    If Err.Number <> 0 Then
        Err.Raise vbObjectError + 105, , "GetVIReference failed: " & Err.Description
    End If

    Dim fso
    Dim stream
    Set fso    = CreateObject("Scripting.FileSystemObject")
    Set stream = fso.CreateTextFile(responsePath, True, False)

    stream.WriteLine "ok=1"
    stream.WriteLine "selection="             & SafeAscii(selection)
    stream.WriteLine "reason_b64="            & EncodeBase64Utf8(reason)
    stream.WriteLine "connected_version_b64=" & EncodeBase64Utf8(connectedVersion)
    stream.WriteLine "connected_directory_b64=" & EncodeBase64Utf8(connectedDirectory)
    stream.WriteLine "attempts="              & CStr(attempts)

    WriteAllProperties stream, updates

    Dim saveOk
    Dim saveErr
    saveOk = True
    saveErr = ""
    If doSave Then
        On Error Resume Next
        Err.Clear
        vi.SaveInstrument
        If Err.Number <> 0 Then
            saveOk = False
            saveErr = "SaveInstrument failed: " & Err.Description
            Err.Clear
        End If
        On Error GoTo 0
    End If

    If saveOk Then
        stream.WriteLine "saved=1"
    Else
        stream.WriteLine "saved=0"
        stream.WriteLine "save_errmsg_b64=" & EncodeBase64Utf8(saveErr)
    End If

    stream.Close
    Set stream = Nothing
    Set fso    = Nothing

    ReleaseComObject vi
    ReleaseComObject app
    WScript.Quit 0
End Sub

' ===========================================================================
' 解析请求文件
'   set_<Name>_type=String|Boolean|Number
'   set_<Name>_val=<Base64-UTF8>
' 返回 Dictionary： Name -> "type|<base64-value>"
' ===========================================================================
Function ParseRequestFile(ByVal pathText)
    Dim fso
    Dim stream
    Dim line
    Dim eqPos
    Dim key
    Dim value
    Dim rest
    Dim propName
    Dim suffix
    Dim dict

    Set dict = CreateObject("Scripting.Dictionary")
    dict.CompareMode = 1

    Set fso = CreateObject("Scripting.FileSystemObject")
    Set stream = fso.OpenTextFile(pathText, 1, False, 0)
    Do Until stream.AtEndOfStream
        line = stream.ReadLine
        If Len(line) > 0 Then
            eqPos = InStr(line, "=")
            If eqPos > 0 Then
                key = Left(line, eqPos - 1)
                value = Mid(line, eqPos + 1)
                If Left(key, 4) = "set_" Then
                    rest = Mid(key, 5)
                    propName = ""
                    suffix = ""
                    If Len(rest) > Len(REQUEST_SUFFIX_TYPE) And LCase(Right(rest, Len(REQUEST_SUFFIX_TYPE))) = REQUEST_SUFFIX_TYPE Then
                        propName = Left(rest, Len(rest) - Len(REQUEST_SUFFIX_TYPE))
                        suffix = REQUEST_PART_TYPE
                    ElseIf Len(rest) > Len(REQUEST_SUFFIX_VAL) And LCase(Right(rest, Len(REQUEST_SUFFIX_VAL))) = REQUEST_SUFFIX_VAL Then
                        propName = Left(rest, Len(rest) - Len(REQUEST_SUFFIX_VAL))
                        suffix = REQUEST_PART_VAL
                    End If
                    If Len(propName) > 0 Then
                        Dim existing
                        Dim partType
                        Dim partVal
                        partType = ""
                        partVal = ""
                        If dict.Exists(propName) Then
                            existing = dict.Item(propName)
                            Dim sep
                            sep = InStr(existing, "|")
                            If sep > 0 Then
                                partType = Left(existing, sep - 1)
                                partVal = Mid(existing, sep + 1)
                            End If
                        End If
                        If suffix = REQUEST_PART_TYPE Then
                            partType = value
                        ElseIf suffix = REQUEST_PART_VAL Then
                            partVal = value
                        End If
                        dict.Item(propName) = partType & "|" & partVal
                    End If
                End If
            End If
        End If
    Loop
    stream.Close
    Set ParseRequestFile = dict
End Function

' ===========================================================================
' Sub WriteAllProperties — 逐属性尝试写入，单个失败不影响其他属性
' ===========================================================================
Sub WriteAllProperties(ByRef stream, ByRef updates)
    Dim keys
    Dim i
    Dim propName
    Dim metaText
    Dim sep
    Dim propType
    Dim category
    Dim payload
    Dim payloadSep
    Dim incomingType
    Dim incomingValB64
    Dim newVal
    Dim ok
    Dim errMsg

    keys = updates.Keys
    For i = 0 To UBound(keys)
        propName = keys(i)
        If Not writableMeta.Exists(propName) Then
            WritePropLine stream, propName, "Unknown", False, "", "Property is not writable or unknown."
        Else
            metaText = writableMeta.Item(propName)
            sep = InStr(metaText, "|")
            propType = Left(metaText, sep - 1)
            category = Mid(metaText, sep + 1)

            payload = updates.Item(propName)
            payloadSep = InStr(payload, "|")
            If payloadSep > 0 Then
                incomingType = Left(payload, payloadSep - 1)
                incomingValB64 = Mid(payload, payloadSep + 1)
            Else
                incomingType = ""
                incomingValB64 = ""
            End If

            ' Type sanity check (informational only — we coerce by propType anyway).
            If Len(incomingType) > 0 And StrComp(incomingType, propType, 1) <> 0 Then
                WritePropLine stream, propName, propType, False, "", _
                    "Type mismatch: requested " & incomingType & ", expected " & propType
            Else
                newVal = DecodeBase64Utf8(incomingValB64)
                On Error Resume Next
                Err.Clear
                AssignProp vi, propName, propType, newVal
                ok = (Err.Number = 0)
                errMsg = Err.Description
                Err.Clear
                On Error GoTo 0
                If ok Then
                    WritePropLine stream, propName, propType, True, ReadBackVi(vi, propName), ""
                Else
                    WritePropLine stream, propName, propType, False, "", errMsg
                End If
            End If
        End If
    Next
End Sub

' ===========================================================================
' 按名称将值赋给 vi 或 fp 对象。VBScript 不支持反射，因此这里逐属性枚举。
' ===========================================================================
Sub AssignProp(ByRef obj, ByVal propName, ByVal propType, ByVal newVal)
    Select Case propName
        Case "Description"        : obj.Description       = CStr(newVal)
        Case "HistoryText"        : obj.HistoryText       = CStr(newVal)
        Case "AllowDebugging"     : obj.AllowDebugging    = CoerceBool(newVal)
        Case "ShowFPOnCall"       : obj.ShowFPOnCall      = CoerceBool(newVal)
        Case "CloseFPAfterCall"   : obj.CloseFPAfterCall  = CoerceBool(newVal)
        Case "IsReentrant"        : obj.IsReentrant       = CoerceBool(newVal)
        Case "RunOnOpen"          : obj.RunOnOpen         = CoerceBool(newVal)
        Case "PreferredExecSystem": obj.PreferredExecSystem = CLng(newVal)
        Case "ExecPriority"       : obj.ExecPriority      = CLng(newVal)
        Case Else
            Err.Raise vbObjectError + 200, , "Unsupported property: " & propName
    End Select
End Sub

Function ReadBackVi(ByRef viRef, ByVal propName)
    On Error Resume Next
    Dim val
    val = ""
    Select Case propName
        Case "Description"        : val = CStr(viRef.Description)
        Case "HistoryText"        : val = CStr(viRef.HistoryText)
        Case "AllowDebugging"     : val = CStr(viRef.AllowDebugging)
        Case "ShowFPOnCall"       : val = CStr(viRef.ShowFPOnCall)
        Case "CloseFPAfterCall"   : val = CStr(viRef.CloseFPAfterCall)
        Case "IsReentrant"        : val = CStr(viRef.IsReentrant)
        Case "RunOnOpen"          : val = CStr(viRef.RunOnOpen)
        Case "PreferredExecSystem": val = CStr(viRef.PreferredExecSystem)
        Case "ExecPriority"       : val = CStr(viRef.ExecPriority)
    End Select
    If Err.Number <> 0 Then val = "" : Err.Clear
    On Error GoTo 0
    ReadBackVi = val
End Function

Function CoerceBool(ByVal value)
    Dim normalized
    normalized = LCase(Trim(CStr(value)))
    If normalized = "1" Or normalized = "true"  Or normalized = "yes" Or normalized = "-1" Then
        CoerceBool = True
    ElseIf normalized = "0" Or normalized = "false" Or normalized = "no" Or normalized = "" Then
        CoerceBool = False
    Else
        CoerceBool = CBool(value)
    End If
End Function

' ===========================================================================
' 写入单个属性的响应行
' ===========================================================================
Sub WritePropLine(ByRef stream, ByVal key, ByVal propType, ByVal ok, ByVal val, ByVal errMsg)
    stream.WriteLine "prop_" & key & "_type=" & propType
    If ok Then
        stream.WriteLine "prop_" & key & "_ok=1"
        stream.WriteLine "prop_" & key & "_val=" & EncodeBase64Utf8(val)
    Else
        stream.WriteLine "prop_" & key & "_ok=0"
        stream.WriteLine "prop_" & key & "_errmsg=" & EncodeBase64Utf8(errMsg)
    End If
End Sub

' ===========================================================================
' 失败时写最小响应文件
' ===========================================================================
Sub WriteFailResponse(ByVal selectionVal, ByVal reasonVal, ByVal versionVal, ByVal directoryVal, ByVal attemptsVal)
    Dim fso
    Dim stream

    On Error Resume Next
    Set fso = CreateObject("Scripting.FileSystemObject")
    If Err.Number <> 0 Then WScript.Quit 3

    Set stream = fso.CreateTextFile(responsePath, True, False)
    If Err.Number <> 0 Then WScript.Quit 3

    stream.WriteLine "ok=0"
    stream.WriteLine "selection="               & SafeAscii(selectionVal)
    stream.WriteLine "reason_b64="              & EncodeBase64Utf8(reasonVal)
    stream.WriteLine "connected_version_b64="   & EncodeBase64Utf8(versionVal)
    stream.WriteLine "connected_directory_b64=" & EncodeBase64Utf8(directoryVal)
    stream.WriteLine "attempts="                & CStr(attemptsVal)
    stream.WriteLine "saved=0"
    stream.Close
    On Error GoTo 0
End Sub

' ===========================================================================
' ConnectLabVIEW — 与 read_vi_props_worker.vbs 相同
' ===========================================================================
Sub ConnectLabVIEW()
    Dim deadline
    Dim createErr
    Dim lastMismatch
    Dim appDir
    Dim appVer

    createErr    = ""
    lastMismatch = ""
    deadline     = DateAdd("s", timeoutSeconds, Now)

    If Len(targetExe) > 0 Then
        CleanupAutomationProcesses targetExe
        WScript.Sleep 400
        StartTargetLabVIEW targetExe
        WScript.Sleep 1000
    End If

    Do While Now < deadline
        attempts = attempts + 1

        On Error Resume Next
        Set app = Nothing
        Err.Clear
        Set app = CreateObject("LabVIEW.Application")

        If Err.Number <> 0 Then
            createErr = "CreateObject failed: " & Err.Description
            Err.Clear
        Else
            appDir = SafeGetAppDirectory(app)
            appVer = SafeGetAppVersion(app)
            connectedDirectory = appDir
            connectedVersion   = appVer

            If AppMatches(appDir, appVer) Then
                On Error GoTo 0
                If Len(targetExe) > 0 Then
                    selection = "matched-target-labview-application"
                    reason    = "Connected to the requested LabVIEW installation."
                Else
                    selection = "connected-default-labview-application"
                    reason    = "No target version specified. Used the current default instance."
                End If
                Exit Sub
            End If

            lastMismatch = "Connected to " & DescribeApp(appDir, appVer) & _
                           ", which does not match the requested target."
            ReleaseComObject app
            Set app = Nothing
        End If
        On Error GoTo 0

        If Len(targetExe) > 0 And (attempts Mod 2 = 0) Then
            CleanupAutomationProcesses targetExe
            WScript.Sleep 300
            StartTargetLabVIEW targetExe
        End If

        WScript.Sleep retryIntervalMs
    Loop

    If Len(lastMismatch) > 0 Then
        selection = "failed-to-match-target-labview-application"
        Err.Raise vbObjectError + 109, , lastMismatch
    End If

    selection = "failed-to-create-labview-application"
    Err.Raise vbObjectError + 110, , createErr
End Sub

Function AppMatches(ByVal appDir, ByVal appVer)
    AppMatches = False
    If Len(expectedDirectory) > 0 Then
        If StrComp(NormalizePath(appDir), NormalizePath(expectedDirectory), vbTextCompare) = 0 Then
            AppMatches = True
            Exit Function
        End If
    End If
    If Len(expectedVersion) > 0 Then
        If LCase(Left(appVer, Len(expectedVersion))) = LCase(expectedVersion) Then
            AppMatches = True
            Exit Function
        End If
    End If
    If Len(expectedDirectory) = 0 And Len(expectedVersion) = 0 Then
        AppMatches = True
    End If
End Function

Function DescribeApp(ByVal appDir, ByVal appVer)
    If Len(appDir) > 0 Then DescribeApp = appDir : Exit Function
    If Len(appVer) > 0 Then DescribeApp = "LabVIEW " & appVer : Exit Function
    DescribeApp = "unknown-instance"
End Function

Sub CleanupAutomationProcesses(ByVal exePath)
    Dim service
    Dim processList
    Dim processItem
    Dim commandLine
    Dim processPath

    On Error Resume Next
    Set service = GetObject("winmgmts:root\cimv2")
    If Err.Number <> 0 Then Err.Clear : Exit Sub

    Set processList = service.ExecQuery( _
        "SELECT ProcessId, CommandLine, ExecutablePath " & _
        "FROM Win32_Process WHERE Name='LabVIEW.exe'")
    If Err.Number <> 0 Then Err.Clear : Exit Sub

    For Each processItem In processList
        commandLine = LCase(NullToEmpty(processItem.CommandLine))
        processPath = NormalizePath(NullToEmpty(processItem.ExecutablePath))
        If processPath = NormalizePath(exePath) Then
            If InStr(1, commandLine, "/automation", vbTextCompare) > 0 Then
                Err.Clear
                processItem.Terminate
                Err.Clear
            End If
        End If
    Next
    On Error GoTo 0
End Sub

Sub StartTargetLabVIEW(ByVal exePath)
    Dim shell
    On Error Resume Next
    Set shell = CreateObject("WScript.Shell")
    If Err.Number = 0 Then
        shell.Run Quote(exePath) & " /Automation", 0, False
        Err.Clear
    End If
    On Error GoTo 0
End Sub

' ===========================================================================
' 工具函数
' ===========================================================================
Function GetNamedArg(ByVal key, ByVal defaultValue)
    If WScript.Arguments.Named.Exists(key) Then
        GetNamedArg = WScript.Arguments.Named.Item(key)
    Else
        GetNamedArg = defaultValue
    End If
End Function

Function FileExists(ByVal pathText)
    Dim fso
    Set fso   = CreateObject("Scripting.FileSystemObject")
    FileExists = fso.FileExists(pathText)
End Function

Function NormalizePath(ByVal pathText)
    Dim normalized
    normalized = Replace(Trim(NullToEmpty(pathText)), "/", "\")
    Do While Len(normalized) > 0 And Right(normalized, 1) = "\"
        normalized = Left(normalized, Len(normalized) - 1)
    Loop
    NormalizePath = LCase(normalized)
End Function

Function NullToEmpty(ByVal value)
    If IsNull(value) Then NullToEmpty = "" Else NullToEmpty = CStr(value)
End Function

Function Quote(ByVal text)
    Quote = Chr(34) & text & Chr(34)
End Function

Function SafeAscii(ByVal value)
    SafeAscii = Replace(Replace(NullToEmpty(value), vbCr, " "), vbLf, " ")
End Function

Function SafeGetAppDirectory(ByRef appRef)
    Err.Clear
    SafeGetAppDirectory = CStr(appRef.ApplicationDirectory)
    If Err.Number <> 0 Then SafeGetAppDirectory = "" : Err.Clear
End Function

Function SafeGetAppVersion(ByRef appRef)
    Err.Clear
    SafeGetAppVersion = CStr(appRef.Version)
    If Err.Number <> 0 Then SafeGetAppVersion = "" : Err.Clear
End Function

' ===========================================================================
' Base64 编码/解码（ADODB.Stream + Msxml2.DOMDocument.6.0）
' ===========================================================================
Function EncodeBase64Utf8(ByVal text)
    Dim stream
    Dim xml
    Dim node
    Dim bytes

    Set stream     = CreateObject("ADODB.Stream")
    stream.Type    = 2
    stream.Charset = "utf-8"
    stream.Open
    stream.WriteText NullToEmpty(text)
    stream.Position = 0
    stream.Type    = 1
    bytes          = stream.Read
    stream.Close

    Set xml             = CreateObject("Msxml2.DOMDocument.6.0")
    Set node            = xml.CreateElement("base64")
    node.DataType       = "bin.base64"
    node.NodeTypedValue = bytes
    EncodeBase64Utf8    = Replace(Replace(node.Text, vbCr, ""), vbLf, "")
End Function

Function DecodeBase64Utf8(ByVal b64)
    Dim stream
    Dim xml
    Dim node
    Dim bytes

    If Len(b64) = 0 Then DecodeBase64Utf8 = "" : Exit Function

    Set xml             = CreateObject("Msxml2.DOMDocument.6.0")
    Set node            = xml.CreateElement("base64")
    node.DataType       = "bin.base64"
    node.Text           = b64
    bytes               = node.NodeTypedValue

    Set stream     = CreateObject("ADODB.Stream")
    stream.Type    = 1
    stream.Open
    stream.Write   bytes
    stream.Position = 0
    stream.Type    = 2
    stream.Charset = "utf-8"
    DecodeBase64Utf8 = stream.ReadText
    stream.Close
End Function

Sub ReleaseComObject(ByRef obj)
    Set obj = Nothing
End Sub
