Option Explicit

' ===========================================================================
' read_vi_props_worker.vbs
' ===========================================================================
' 通过 LabVIEW ActiveX/COM 读取 VI 的全部可访问属性。
'
' 本脚本由 read_vi_props.py 调度，不应直接运行。
'
' 命名参数（由 Python 以 /key:value 形式传入）
' -----------------------------------------
'   /viPath             VI 文件完整路径（必填）
'   /responsePath       结果输出文件路径（必填）
'   /timeoutSeconds     连接超时秒数（默认 45）
'   /targetExe          目标 LabVIEW.exe 路径（可选；有则精确匹配）
'   /expectedDirectory  预期的 ApplicationDirectory（可选）
'   /expectedVersion    预期的 Version 前缀，例如 "17.0"（可选）
'
' 响应文件格式（ASCII 编码）
' -------------------------
'   ok=1|0
'   selection=<ascii>
'   reason_b64=<Base64-UTF8>
'   connected_version_b64=<Base64-UTF8>
'   connected_directory_b64=<Base64-UTF8>
'   attempts=<整数>
'   prop_<Name>_type=String|Boolean|Number
'   prop_<Name>_ok=1|0
'   prop_<Name>_val=<Base64-UTF8>       (ok=1 时)
'   prop_<Name>_errmsg=<Base64-UTF8>    (ok=0 时)
'   ...（每个属性三行）
' ===========================================================================

' ---------------------------------------------------------------------------
' 读取命名参数
' ---------------------------------------------------------------------------
Dim viPath
Dim targetExe
Dim expectedDirectory
Dim expectedVersion
Dim responsePath
Dim timeoutSeconds
Dim retryIntervalMs

viPath            = GetNamedArg("viPath", "")
targetExe         = GetNamedArg("targetExe", "")
expectedDirectory = GetNamedArg("expectedDirectory", "")
expectedVersion   = GetNamedArg("expectedVersion", "")
responsePath      = GetNamedArg("responsePath", "")
timeoutSeconds    = CLng(GetNamedArg("timeoutSeconds", "45"))
retryIntervalMs   = 750

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
    If Not FileExists(viPath) Then
        Err.Raise vbObjectError + 102, , "VI file not found: " & viPath
    End If

    ConnectLabVIEW

    Err.Clear
    Set vi = app.GetVIReference(viPath)
    If Err.Number <> 0 Then
        Err.Raise vbObjectError + 103, , "GetVIReference failed: " & Err.Description
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

    ReadAllProperties stream

    stream.Close
    Set stream = Nothing
    Set fso    = Nothing

    ReleaseComObject vi
    ReleaseComObject app
    WScript.Quit 0
End Sub

' ===========================================================================
' Sub ReadAllProperties  —  逐属性尝试读取，单个失败不影响其他属性
' ===========================================================================
Sub ReadAllProperties(ByRef stream)
    Dim val
    Dim ok
    Dim errMsg
    Dim fp
    Dim fpOk
    Dim fpErrMsg

    ' 全局 On Error Resume Next，逐属性检查 Err.Number
    On Error Resume Next

    ' -----------------------------------------------------------------------
    ' String 属性（只读）
    ' -----------------------------------------------------------------------

    ' Name — VI 文件名（不含路径），只读
    val = "" : Err.Clear
    val = CStr(vi.Name)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "Name", "String", ok, val, errMsg

    ' Path — VI 文件完整路径，只读
    val = "" : Err.Clear
    val = CStr(vi.Path)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "Path", "String", ok, val, errMsg

    ' LVVersion — 最近一次保存该 VI 的 LabVIEW 版本字符串，只读
    val = "" : Err.Clear
    val = CStr(vi.LVVersion)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "LVVersion", "String", ok, val, errMsg

    ' -----------------------------------------------------------------------
    ' String 属性（可读写）
    ' -----------------------------------------------------------------------

    ' Description — VI 描述，可读写
    val = "" : Err.Clear
    val = CStr(vi.Description)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "Description", "String", ok, val, errMsg

    ' HistoryText — 修订历史日志，可读写
    val = "" : Err.Clear
    val = CStr(vi.HistoryText)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "HistoryText", "String", ok, val, errMsg

    ' PrintHeader — 打印页眉，可读写
    val = "" : Err.Clear
    val = CStr(vi.PrintHeader)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "PrintHeader", "String", ok, val, errMsg

    ' PrintFooter — 打印页脚，可读写
    val = "" : Err.Clear
    val = CStr(vi.PrintFooter)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "PrintFooter", "String", ok, val, errMsg

    ' -----------------------------------------------------------------------
    ' Boolean 属性（只读）
    ' -----------------------------------------------------------------------

    ' HasChanges — VI 是否有未保存的修改，只读
    val = "" : Err.Clear
    val = CStr(vi.HasChanges)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "HasChanges", "Boolean", ok, val, errMsg

    ' Protected — 框图是否已加密保护，只读
    val = "" : Err.Clear
    val = CStr(vi.Protected)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "Protected", "Boolean", ok, val, errMsg

    ' IsRunning — VI 当前是否正在运行，只读
    val = "" : Err.Clear
    val = CStr(vi.IsRunning)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "IsRunning", "Boolean", ok, val, errMsg

    ' -----------------------------------------------------------------------
    ' Boolean 属性（可读写）
    ' -----------------------------------------------------------------------

    ' AllowDebugging — 允许调试，可读写
    val = "" : Err.Clear
    val = CStr(vi.AllowDebugging)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "AllowDebugging", "Boolean", ok, val, errMsg

    ' BreakOnError — 出错时暂停，可读写
    val = "" : Err.Clear
    val = CStr(vi.BreakOnError)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "BreakOnError", "Boolean", ok, val, errMsg

    ' SuspendWhenCalled — 被调用时挂起，可读写
    val = "" : Err.Clear
    val = CStr(vi.SuspendWhenCalled)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "SuspendWhenCalled", "Boolean", ok, val, errMsg

    ' ShowFPOnCall — 被调用时显示前面板，可读写
    val = "" : Err.Clear
    val = CStr(vi.ShowFPOnCall)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "ShowFPOnCall", "Boolean", ok, val, errMsg

    ' CloseAfterCall — 调用完毕后关闭前面板，可读写
    val = "" : Err.Clear
    val = CStr(vi.CloseAfterCall)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "CloseAfterCall", "Boolean", ok, val, errMsg

    ' Scalable — 前面板是否可缩放，可读写
    val = "" : Err.Clear
    val = CStr(vi.Scalable)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "Scalable", "Boolean", ok, val, errMsg

    ' ShowScrollbars — 显示前面板滚动条，可读写
    val = "" : Err.Clear
    val = CStr(vi.ShowScrollbars)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "ShowScrollbars", "Boolean", ok, val, errMsg

    ' InlineSubVI — 是否内联（LV 2010+），可读写
    val = "" : Err.Clear
    val = CStr(vi.InlineSubVI)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "InlineSubVI", "Boolean", ok, val, errMsg

    ' -----------------------------------------------------------------------
    ' Number 属性（只读）
    ' -----------------------------------------------------------------------

    ' Revision — VI 修订计数器，只读
    val = "" : Err.Clear
    val = CStr(vi.Revision)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "Revision", "Number", ok, val, errMsg

    ' -----------------------------------------------------------------------
    ' Number 属性（可读写）
    ' -----------------------------------------------------------------------

    ' ReentrantType — 可重入类型：0=不可重入, 1=预分配副本, 2=共享副本；可读写
    val = "" : Err.Clear
    val = CStr(vi.ReentrantType)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "ReentrantType", "Number", ok, val, errMsg

    ' Priority — 执行优先级：0=后台, 1=正常, 2=较高, 3=高, 4=时间关键, 5=子程序；可读写
    val = "" : Err.Clear
    val = CStr(vi.Priority)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "Priority", "Number", ok, val, errMsg

    ' -----------------------------------------------------------------------
    ' FP (Front Panel) 子对象属性
    ' -----------------------------------------------------------------------
    Set fp = Nothing : Err.Clear
    Set fp = vi.FP
    fpOk     = (Err.Number = 0)
    fpErrMsg = Err.Description
    Err.Clear

    If fpOk Then
        ' FPTitle — 前面板窗口标题，可读写
        val = "" : Err.Clear
        val = CStr(fp.Title)
        ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
        WritePropLine stream, "FPTitle", "String", ok, val, errMsg

        ' FPOpen — 前面板窗口是否当前打开，只读
        val = "" : Err.Clear
        val = CStr(fp.Open)
        ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
        WritePropLine stream, "FPOpen", "Boolean", ok, val, errMsg

        Set fp = Nothing
    Else
        WritePropLine stream, "FPTitle", "String", False, "", "FP object inaccessible: " & fpErrMsg
        WritePropLine stream, "FPOpen",  "Boolean", False, "", "FP object inaccessible: " & fpErrMsg
    End If

    On Error GoTo 0
End Sub

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
' 失败时写最小响应文件（不含属性数据）
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
    stream.Close
    On Error GoTo 0
End Sub

' ===========================================================================
' ConnectLabVIEW  —  与 read_vi_description_worker.vbs 相同逻辑
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

' ===========================================================================
' 匹配判断
' ===========================================================================
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

' ===========================================================================
' 进程管理
' ===========================================================================
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
' Base64 编码 / 解码（ADODB.Stream + Msxml2.DOMDocument.6.0）
' ===========================================================================
Function EncodeBase64Utf8(ByVal text)
    Dim stream
    Dim xml
    Dim node
    Dim bytes

    Set stream     = CreateObject("ADODB.Stream")
    stream.Type    = 2       ' adTypeText
    stream.Charset = "utf-8"
    stream.Open
    stream.WriteText NullToEmpty(text)
    stream.Position = 0
    stream.Type    = 1       ' adTypeBinary
    bytes          = stream.Read
    stream.Close

    Set xml            = CreateObject("Msxml2.DOMDocument.6.0")
    Set node           = xml.CreateElement("base64")
    node.DataType      = "bin.base64"
    node.NodeTypedValue = bytes
    EncodeBase64Utf8   = Replace(Replace(node.Text, vbCr, ""), vbLf, "")
End Function

Sub ReleaseComObject(ByRef obj)
    Set obj = Nothing
End Sub
