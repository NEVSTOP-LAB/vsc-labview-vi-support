Option Explicit

' ===========================================================================
' read_vi_description_worker.vbs
' ===========================================================================
' 通过 LabVIEW ActiveX/COM 读取 VI 的 Description 属性。
'
' 本脚本由 read_vi_description.py 调度，不应直接运行。
' Python 负责选择与目标 LabVIEW 安装位数一致的 cscript.exe 来宿主此脚本：
'   x86 LabVIEW  ->  C:\Windows\SysWOW64\cscript.exe
'   x64 LabVIEW  ->  C:\Windows\System32\cscript.exe
'
' 命名参数（由 Python 以 /key:value 形式传入）
' -----------------------------------------
'   /viPath          VI 文件的完整路径（必填）
'   /responsePath    结果输出文件路径（必填）
'   /timeoutSeconds  连接超时秒数（默认 45）
'   /targetExe       目标 LabVIEW.exe 路径（可选；有则精确匹配）
'   /expectedDirectory  预期的 ApplicationDirectory（可选）
'   /expectedVersion    预期的 Version 前缀，例如 "17.0"（可选）
'
' 响应文件格式（每行 key=value，ASCII 编码）
' -----------------------------------------
'   ok=1|0
'   selection=<ascii 标识>
'   reason_b64=<Base64-UTF8>
'   connected_version_b64=<Base64-UTF8>
'   connected_directory_b64=<Base64-UTF8>
'   value_b64=<Base64-UTF8>        <- VI.Description 的内容
'   attempts=<整数>
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
Dim valueText

Set app            = Nothing
Set vi             = Nothing
attempts           = 0
selection          = ""
reason             = ""
connectedVersion   = ""
connectedDirectory = ""
valueText          = ""

' ---------------------------------------------------------------------------
' 顶层执行（错误被 On Error Resume Next 捕获后写响应文件）
' ---------------------------------------------------------------------------
On Error Resume Next
Main
If Err.Number <> 0 Then
    reason = Err.Description
    WriteResponse False, selection, reason, connectedVersion, connectedDirectory, valueText, attempts
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

    ' 建立 COM 连接（含超时重试）
    ConnectLabVIEW

    ' 打开 VI
    Err.Clear
    Set vi = app.GetVIReference(viPath)
    If Err.Number <> 0 Then
        Err.Raise vbObjectError + 103, , "GetVIReference failed: " & Err.Description
    End If

    ' 读取 Description
    Err.Clear
    valueText = CStr(vi.Description)
    If Err.Number <> 0 Then
        Err.Raise vbObjectError + 105, , "Read VI.Description failed: " & Err.Description
    End If

    WriteResponse True, selection, reason, connectedVersion, connectedDirectory, valueText, attempts
    ReleaseComObject vi
    ReleaseComObject app
    WScript.Quit 0
End Sub

' ===========================================================================
' Sub ConnectLabVIEW
' ===========================================================================
Sub ConnectLabVIEW()
    Dim deadline
    Dim createErr
    Dim lastMismatch
    Dim appDir
    Dim appVer

    createErr   = ""
    lastMismatch = ""
    deadline    = DateAdd("s", timeoutSeconds, Now)

    ' 若指定了目标 LabVIEW.exe，先清理残留的 /Automation 实例，再启动目标版本
    If Len(targetExe) > 0 Then
        CleanupAutomationProcesses targetExe
        WScript.Sleep 400
        StartTargetLabVIEW targetExe
        WScript.Sleep 1000
    End If

    Do While Now < deadline
        attempts = attempts + 1

        ' 保护 CreateObject 调用：失败则记录错误并继续重试
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

        ' 每隔两次尝试，重新清理并启动目标版本（防止旧实例残留干扰）
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
' 匹配目标实例
' ===========================================================================
Function AppMatches(ByVal appDir, ByVal appVer)
    AppMatches = False

    ' 优先用目录匹配（最精确）
    If Len(expectedDirectory) > 0 Then
        If StrComp(NormalizePath(appDir), NormalizePath(expectedDirectory), vbTextCompare) = 0 Then
            AppMatches = True
            Exit Function
        End If
    End If

    ' 其次用版本前缀匹配
    If Len(expectedVersion) > 0 Then
        If LCase(Left(appVer, Len(expectedVersion))) = LCase(expectedVersion) Then
            AppMatches = True
            Exit Function
        End If
    End If

    ' 未设置任何期望条件时，直接接受当前连接
    If Len(expectedDirectory) = 0 And Len(expectedVersion) = 0 Then
        AppMatches = True
    End If
End Function

Function DescribeApp(ByVal appDir, ByVal appVer)
    If Len(appDir) > 0 Then
        DescribeApp = appDir
        Exit Function
    End If
    If Len(appVer) > 0 Then
        DescribeApp = "LabVIEW " & appVer
        Exit Function
    End If
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
    Set service     = GetObject("winmgmts:root\cimv2")
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
                Err.Clear  ' Terminate 可能因权限不足失败，忽略
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
' 响应文件写入
' ===========================================================================
Sub WriteResponse(ByVal okValue, ByVal selectionValue, ByVal reasonValue, _
                  ByVal versionValue, ByVal directoryValue, _
                  ByVal valueResult, ByVal attemptsValue)
    Dim fso
    Dim stream

    Set fso    = CreateObject("Scripting.FileSystemObject")
    Set stream = fso.CreateTextFile(responsePath, True, False)

    stream.WriteLine "ok="                    & BoolToString(okValue)
    stream.WriteLine "selection="             & SafeAscii(selectionValue)
    stream.WriteLine "reason_b64="            & EncodeBase64Utf8(reasonValue)
    stream.WriteLine "connected_version_b64=" & EncodeBase64Utf8(versionValue)
    stream.WriteLine "connected_directory_b64=" & EncodeBase64Utf8(directoryValue)
    stream.WriteLine "value_b64="             & EncodeBase64Utf8(valueResult)
    stream.WriteLine "attempts="              & CStr(attemptsValue)
    stream.Close
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
    If IsNull(value) Then
        NullToEmpty = ""
    Else
        NullToEmpty = CStr(value)
    End If
End Function

Function Quote(ByVal text)
    Quote = Chr(34) & text & Chr(34)
End Function

Function BoolToString(ByVal value)
    If value Then
        BoolToString = "1"
    Else
        BoolToString = "0"
    End If
End Function

Function SafeAscii(ByVal value)
    SafeAscii = Replace(Replace(NullToEmpty(value), vbCr, " "), vbLf, " ")
End Function

Function SafeGetAppDirectory(ByRef appRef)
    Err.Clear
    SafeGetAppDirectory = CStr(appRef.ApplicationDirectory)
    If Err.Number <> 0 Then
        SafeGetAppDirectory = ""
        Err.Clear
    End If
End Function

Function SafeGetAppVersion(ByRef appRef)
    Err.Clear
    SafeGetAppVersion = CStr(appRef.Version)
    If Err.Number <> 0 Then
        SafeGetAppVersion = ""
        Err.Clear
    End If
End Function

' ---------------------------------------------------------------------------
' Base64 编码 / 解码（使用 ADODB.Stream + MSXML2）
' ---------------------------------------------------------------------------
Function EncodeBase64Utf8(ByVal text)
    Dim stream
    Dim xml
    Dim node
    Dim bytes

    Set stream      = CreateObject("ADODB.Stream")
    stream.Type     = 2        ' adTypeText
    stream.Charset  = "utf-8"
    stream.Open
    stream.WriteText NullToEmpty(text)
    stream.Position = 0
    stream.Type     = 1        ' adTypeBinary
    bytes           = stream.Read
    stream.Close

    Set xml         = CreateObject("Msxml2.DOMDocument.6.0")
    Set node        = xml.CreateElement("base64")
    node.DataType   = "bin.base64"
    node.NodeTypedValue = bytes
    EncodeBase64Utf8 = Replace(Replace(node.Text, vbCr, ""), vbLf, "")
End Function

Function DecodeBase64Utf8(ByVal text)
    Dim xml
    Dim node
    Dim stream

    If Len(text) = 0 Then
        DecodeBase64Utf8 = ""
        Exit Function
    End If

    Set xml            = CreateObject("Msxml2.DOMDocument.6.0")
    Set node           = xml.CreateElement("base64")
    node.DataType      = "bin.base64"
    node.Text          = text

    Set stream         = CreateObject("ADODB.Stream")
    stream.Type        = 1    ' adTypeBinary
    stream.Open
    stream.Write       node.NodeTypedValue
    stream.Position    = 0
    stream.Type        = 2    ' adTypeText
    stream.Charset     = "utf-8"
    DecodeBase64Utf8   = stream.ReadText
    stream.Close
End Function

Sub ReleaseComObject(ByRef obj)
    Set obj = Nothing
End Sub
